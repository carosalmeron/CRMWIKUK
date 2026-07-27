// ─────────────────────────────────────────────────────────────
//  /api/pbi-sync.js
//  Sincroniza Power BI (modelo "Global United Caro") → Firestore
//
//  Lo lanza el cron de Vercel cada noche. NO se llama desde el
//  navegador: las credenciales viven solo en variables de entorno.
//
//  Colecciones que escribe:
//    pbi_ventas_cliente/{CODIGO}   ventas y margen por cliente
//    pbi_pendiente_servir/{CODIGO} pedidos pendientes de servir
//    pbi_stock/{REFERENCIA}        stock disponible por referencia
//    pbi_meta/estado               última sincronización y contadores
//
//  Variables de entorno necesarias en Vercel:
//    PBI_TENANT_ID, PBI_CLIENT_ID, PBI_CLIENT_SECRET
//    PBI_GROUP_ID       (id del workspace, va en la URL de Power BI)
//    PBI_DATASET_ID     (id del modelo semántico, también en la URL)
//    FB_PROJECT_ID      (= grupo-consolidado-crm)
//    FB_API_KEY         (opcional: solo si se cierran las reglas)
//    CRON_SECRET        (cadena aleatoria, protege el endpoint)
// ─────────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════
//  ZONA A REVISAR: nombres de tablas, columnas y medidas
//  Ábrelos en Power BI (flecha ">" de cada tabla) y ajusta aquí.
//  Si un nombre no coincide exactamente, el DAX devuelve error 400.
// ══════════════════════════════════════════════════════════════
const M = {
  clientes:   "'00 Clientes Global'",
  ventas:     "'00 Ventas Mercancias Global'",
  pendiente:  "'00 Stock Pendiente de Servir Global'",
  stock:      "'00 Stock'",
  tiempo:     "'Lk_tiempo'",

  colCodigo:  "'00 Clientes Global'[CODIGO]",
  colNombre:  "'00 Clientes Global'[NOMBRE]",
  colAgente:  "'00 Clientes Global'[GRUPOAGENTE]",
  colEmpresa: "'00 Clientes Global'[Empresa]",
  colFecha:   "'Lk_tiempo'[Date]",

  // Medidas ya existentes en el modelo (tabla "Medidas Ventas" /
  // "Medidas Global"). Si no existen, sustituye por SUM(...) directo.
  medVentas:  "[Ventas]",
  medMargen:  "[Margen Bruto]",
  medMargenP: "[% Margen]",
};

const DIAS_HISTORICO = 365;

// ─────────────── Lectura defensiva de variables de entorno ───────────────
// Al copiar IDs de un email o un chat es facil arrastrar tabuladores,
// espacios o saltos de linea invisibles. Azure y Power BI los rechazan
// sin explicar por que, asi que se limpian aqui de una vez.
function env(nombre) {
  const v = process.env[nombre];
  return v === undefined ? undefined : String(v).trim();
}
const ENV = new Proxy({}, { get: (_, k) => env(k) });

// ─────────────── Consultas DAX ───────────────
function dax() {
  return {
    // 1) Ventas y margen por cliente: total 12 meses + mes en curso
    ventas: `
DEFINE
  VAR _hoy = TODAY()
  VAR _desde = _hoy - ${DIAS_HISTORICO}
  VAR _iniMes = DATE(YEAR(_hoy), MONTH(_hoy), 1)
EVALUATE
  SUMMARIZECOLUMNS(
    ${M.colCodigo},
    ${M.colNombre},
    ${M.colAgente},
    ${M.colEmpresa},
    "VentasAno",  CALCULATE(${M.medVentas},  ${M.colFecha} >= _desde  && ${M.colFecha} <= _hoy),
    "MargenAno",  CALCULATE(${M.medMargen},  ${M.colFecha} >= _desde  && ${M.colFecha} <= _hoy),
    "VentasMes",  CALCULATE(${M.medVentas},  ${M.colFecha} >= _iniMes && ${M.colFecha} <= _hoy),
    "MargenMes",  CALCULATE(${M.medMargen},  ${M.colFecha} >= _iniMes && ${M.colFecha} <= _hoy),
    "MargenPct",  CALCULATE(${M.medMargenP}, ${M.colFecha} >= _iniMes && ${M.colFecha} <= _hoy)
  )
  ORDER BY [VentasAno] DESC`,

    // 2) Pedidos pendientes de servir, agrupados por cliente
    pendiente: `
EVALUATE
  SUMMARIZECOLUMNS(
    ${M.pendiente}[CODIGO],
    "Importe", SUM(${M.pendiente}[IMPORTE]),
    "Lineas",  COUNTROWS(${M.pendiente})
  )`,

    // 3) Stock disponible por referencia
    stock: `
EVALUATE
  SUMMARIZECOLUMNS(
    ${M.stock}[REFERENCIA],
    ${M.stock}[DESCRIPCION],
    "Unidades", SUM(${M.stock}[STOCK])
  )`,
  };
}

// ─────────────── Power BI: token OAuth2 ───────────────
//
//  Soporta dos modos, elegidos automáticamente:
//
//  A) SECRETO      → si existe PBI_CLIENT_SECRET.
//                    Simple, pero caduca y hay que rotarlo a mano.
//
//  B) OIDC (federado) → si no hay secreto y Vercel emite token OIDC.
//                    No hay credencial que guardar ni que caduque.
//                    Requiere activar en Vercel: Project Settings →
//                    Security → "Secure backend access with OIDC
//                    federation", en modo Team, y dar de alta una
//                    credencial federada en Entra (ver README).
//
function oidcToken(req) {
  // Vercel inyecta el token como cabecera en cada invocación de la función,
  // y como variable de entorno en build. No requiere paquete adicional.
  return req.headers["x-vercel-oidc-token"] || process.env.VERCEL_OIDC_TOKEN || null;
}

async function getToken(req) {
  const url = `https://login.microsoftonline.com/${ENV.PBI_TENANT_ID}/oauth2/v2.0/token`;
  const base = {
    grant_type: "client_credentials",
    client_id: ENV.PBI_CLIENT_ID,
    scope: "https://analysis.windows.net/powerbi/api/.default",
  };

  let body, modo;
  if (ENV.PBI_CLIENT_SECRET) {
    modo = "secreto";
    body = new URLSearchParams({ ...base, client_secret: ENV.PBI_CLIENT_SECRET });
  } else {
    const assertion = oidcToken(req);
    if (!assertion) {
      throw new Error(
        "Sin PBI_CLIENT_SECRET y sin token OIDC. Activa OIDC federation " +
        "en Vercel (Settings → Security) o define el secreto."
      );
    }
    modo = "oidc";
    body = new URLSearchParams({
      ...base,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
    });
  }

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json();
  if (!r.ok) {
    throw new Error(`Token Azure AD (modo ${modo}): ${j.error_description || j.error || r.status}`);
  }
  return { token: j.access_token, modo };
}

// ─────────────── Power BI: executeQueries ───────────────
// Límites de la API: 100.000 filas y 15 MB por consulta.
// Por eso siempre se agrega en DAX, nunca se piden filas crudas.
async function pbiQuery(token, query) {
  const url =
    `https://api.powerbi.com/v1.0/myorg/groups/${ENV.PBI_GROUP_ID}` +
    `/datasets/${ENV.PBI_DATASET_ID}/executeQueries`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      queries: [{ query }],
      serializerSettings: { includeNulls: false },
    }),
  });
  const j = await r.json();
  if (!r.ok) {
    const det = j.error?.["pbi.error"]?.details?.[0]?.detail?.value || j.error?.message;
    throw new Error(`Power BI: ${det || r.status}`);
  }
  return j.results[0].tables[0].rows || [];
}

// Power BI devuelve las claves como "Tabla[Columna]" o "[Alias]".
// Este helper busca por el nombre final sin importar el prefijo.
function pick(row, name) {
  const k = Object.keys(row).find((x) => x.endsWith(`[${name}]`) || x === name);
  return k === undefined ? null : row[k];
}
const num = (v) => (v === null || v === undefined || isNaN(v) ? 0 : Math.round(Number(v) * 100) / 100);

// ─────────────── Firestore: escritura por lotes ───────────────
function toFields(obj) {
  const f = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "number") f[k] = { doubleValue: v };
    else if (typeof v === "boolean") f[k] = { booleanValue: v };
    else f[k] = { stringValue: String(v) };
  }
  return f;
}

async function fbCommit(coleccion, docs) {
  const base = `projects/${ENV.FB_PROJECT_ID}/databases/(default)/documents`;
  // El CRM accede a Firestore sin clave (reglas abiertas). Si algún día se
  // cierran las reglas, basta con definir FB_API_KEY en Vercel.
  const q = ENV.FB_API_KEY ? `?key=${ENV.FB_API_KEY}` : "";
  const url = `https://firestore.googleapis.com/v1/${base}:commit${q}`;
  let escritos = 0;

  // El endpoint :commit admite máximo 500 escrituras por llamada
  for (let i = 0; i < docs.length; i += 400) {
    const lote = docs.slice(i, i + 400).map((d) => ({
      update: {
        name: `${base}/${coleccion}/${d._id}`,
        fields: toFields({ ...d, _id: undefined }),
      },
      // sin updateMask = reemplaza el documento entero (lo que queremos:
      // así un cliente que deja de tener ventas se queda a 0, no obsoleto)
    }));
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ writes: lote }),
    });
    if (!r.ok) throw new Error(`Firestore ${coleccion}: ${(await r.text()).slice(0, 200)}`);
    escritos += lote.length;
  }
  return escritos;
}

// Limpia el código para usarlo como id de documento
const docId = (v) => String(v || "").trim().replace(/[/#?\[\]*]/g, "_") || "SIN_CODIGO";

// ─────────────── Handler ───────────────
export default async function handler(req, res) {
  // Solo el cron de Vercel (o tú con el secreto) puede lanzarlo
  const auth = req.headers.authorization || "";
  const secreto = req.query.secret || auth.replace("Bearer ", "");
  if (ENV.CRON_SECRET && secreto !== ENV.CRON_SECRET) {
    return res.status(401).json({ error: "no autorizado" });
  }

  // ?diag=1 → lista lo que el service principal REALMENTE ve.
  // Sirve para demostrar a sistemas si el acceso al workspace está dado.
  if (req.query.diag === "1") {
    try {
      const { token, modo } = await getToken(req);
      const r = await fetch("https://api.powerbi.com/v1.0/myorg/groups", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = await r.json();
      const ws = (j.value || []).map((g) => ({ id: g.id, nombre: g.name }));
      return res.status(200).json({
        ok: true,
        modoAuth: modo,
        workspacesVisibles: ws.length,
        workspaces: ws,
        buscado: ENV.PBI_GROUP_ID,
        encontrado: ws.some((g) => g.id === ENV.PBI_GROUP_ID),
        diagnostico: ws.length === 0
          ? "El service principal no ve NINGUN workspace. Falta el ajuste de tenant o el grupo de seguridad."
          : ws.some((g) => g.id === ENV.PBI_GROUP_ID)
            ? "Acceso al workspace OK. Si executeQueries falla, falta permiso Build o el ajuste de Execute Queries."
            : "El SP ve workspaces pero NO el de UNITED. Falta anadirlo a ese workspace.",
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  const dry = req.query.dry === "1"; // ?dry=1 → consulta pero NO escribe
  const t0 = Date.now();
  const log = { dry, ventas: 0, pendiente: 0, stock: 0, errores: [] };

  try {
    const { token, modo } = await getToken(req);
    log.modoAuth = modo;
    const Q = dax();

    // ── 1. Ventas y margen por cliente ──
    try {
      const filas = await pbiQuery(token, Q.ventas);
      const docs = filas.map((r) => ({
        _id: docId(pick(r, "CODIGO")),
        codigo: pick(r, "CODIGO"),
        nombre: pick(r, "NOMBRE"),
        grupoAgente: pick(r, "GRUPOAGENTE"),
        empresa: pick(r, "Empresa"),
        ventasAno: num(pick(r, "VentasAno")),
        margenAno: num(pick(r, "MargenAno")),
        ventasMes: num(pick(r, "VentasMes")),
        margenMes: num(pick(r, "MargenMes")),
        margenPct: num(pick(r, "MargenPct")),
        actualizado: new Date().toISOString(),
      }));
      log.ventas = dry ? docs.length : await fbCommit("pbi_ventas_cliente", docs);
      if (dry) log.muestraVentas = docs.slice(0, 3);
    } catch (e) {
      log.errores.push(`ventas: ${e.message}`);
    }

    // ── 2. Pedidos pendientes de servir ──
    try {
      const filas = await pbiQuery(token, Q.pendiente);
      const docs = filas.map((r) => ({
        _id: docId(pick(r, "CODIGO")),
        codigo: pick(r, "CODIGO"),
        importePendiente: num(pick(r, "Importe")),
        lineas: num(pick(r, "Lineas")),
        actualizado: new Date().toISOString(),
      }));
      log.pendiente = dry ? docs.length : await fbCommit("pbi_pendiente_servir", docs);
      if (dry) log.muestraPendiente = docs.slice(0, 3);
    } catch (e) {
      log.errores.push(`pendiente: ${e.message}`);
    }

    // ── 3. Stock por referencia ──
    try {
      const filas = await pbiQuery(token, Q.stock);
      const docs = filas.map((r) => ({
        _id: docId(pick(r, "REFERENCIA")),
        referencia: pick(r, "REFERENCIA"),
        descripcion: pick(r, "DESCRIPCION"),
        unidades: num(pick(r, "Unidades")),
        actualizado: new Date().toISOString(),
      }));
      log.stock = dry ? docs.length : await fbCommit("pbi_stock", docs);
      if (dry) log.muestraStock = docs.slice(0, 3);
    } catch (e) {
      log.errores.push(`stock: ${e.message}`);
    }

    // ── 4. Sello de sincronización (lo lee el CRM para avisar si va viejo) ──
    log.segundos = Math.round((Date.now() - t0) / 1000);
    if (!dry) {
      await fbCommit("pbi_meta", [{
        _id: "estado",
        ultimaSync: new Date().toISOString(),
        ventas: log.ventas,
        pendienteServir: log.pendiente,
        stock: log.stock,
        errores: log.errores.join(" | "),
        segundos: log.segundos,
      }]);
    }

    return res.status(log.errores.length ? 207 : 200).json({ ok: true, ...log });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, ...log });
  }
}
