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
  // ══ VERIFICADO con ?peek=1 el 27/07/2026 ══
  // OJO: en esta tabla CODIGO es el ARTICULO, no el cliente.
  // El cliente es la columna CLIENTE ("DELABORI", "BARBELA"...).
  ventas:     "'00 Ventas Mercancias Global'",
  vCliente:   "'00 Ventas Mercancias Global'[CLIENTE]",
  vVendedor:  "'00 Ventas Mercancias Global'[VENDEDOR]",
  vEmpresa:   "'00 Ventas Mercancias Global'[EMPRESA]",
  vFecha:     "'00 Ventas Mercancias Global'[FECHA]",
  vBase:      "'00 Ventas Mercancias Global'[BASE]",             // importe, numerico
  vCoste:     "'00 Ventas Mercancias Global'[Costo Referencia]", // coste, numerico
  // NO usar [Margen]: es texto con coma decimal ("22,4360695652174").
  // El margen se deriva de BASE - Coste, que da el mismo resultado.

  // Pendiente de servir: solo articulo y unidades, sin importe ni cliente.
  pendiente:  "'00 Stock Pendiente de Servir Global'",
  pCodigo:    "'00 Stock Pendiente de Servir Global'[CODIGO]",
  pUni:       "'00 Stock Pendiente de Servir Global'[UNI]",
  pEstado:    "'00 Stock Pendiente de Servir Global'[ESTADO]",

  // 00 Stock no tiene columna de cantidad. Pendiente de averiguar
  // donde vive el stock disponible antes de sincronizarlo.
  stock:      "'00 Stock'",

  clientes:   "'00 Clientes Global'",
  cNombre:    "'00 Clientes Global'[NOMBRE]",
  cPoblacion: "'00 Clientes Global'[POBLACION]",
  cProvincia: "'00 Clientes Global'[PROVINCIA]",
  cBloqueado: "'00 Clientes Global'[BLQ]",
};

const DIAS_HISTORICO = 365;

// Bloques que se sincronizan de verdad. "stock" queda fuera a proposito:
// la tabla '00 Stock' no tiene columna de cantidad, asi que ahora mismo
// solo devolveria un recuento de registros (13.666 filas sin valor).
// Reactivar cuando sistemas indique donde vive el stock disponible.
const ACTIVOS = ["ventas"];

// Ventas intercompania: traspasos entre empresas del propio grupo, no
// clientes reales. En los informes de Power BI ya se excluyen con el
// filtro "GRUPONIVEL1 es No Intercompany". Aqui no se borran (el dato
// es correcto y puede interesar a direccion), se marcan con el campo
// "intercompany" para que el CRM decida si los muestra.
// Ampliable sin tocar codigo con la variable INTERCOMPANY en Vercel,
// separando patrones por comas.
const PATRONES_INTERCOMPANY = (env("INTERCOMPANY") || "WIKUK,INTERKEY,UNITED CARO,DISCOB,JBOSCH")
  .split(",")
  .map((x) => x.trim().toUpperCase())
  .filter(Boolean);

const esIntercompany = (nombre) => {
  const n = String(nombre || "").toUpperCase();
  return PATRONES_INTERCOMPANY.some((pat) => n.includes(pat));
};
const activo = (b) => ACTIVOS.includes(b) || false;

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
    // 1) Ventas, coste y margen por cliente: 12 meses + mes en curso.
    //    Se intenta primero enriqueciendo con nombre y poblacion desde
    //    '00 Clientes Global'. Si no existe relacion en el modelo, la
    //    consulta falla y se reintenta con la version simple (ventasSimple).
    ventas: `
DEFINE
  VAR _hoy = TODAY()
  VAR _12m = _hoy - ${DIAS_HISTORICO}
  VAR _iniMes = DATE(YEAR(_hoy), MONTH(_hoy), 1)
  VAR _iniAno = DATE(YEAR(_hoy), 1, 1)
  VAR _iniSem = _hoy - WEEKDAY(_hoy, 2) + 1
EVALUATE
  SUMMARIZECOLUMNS(
    ${M.vCliente},
    ${M.vVendedor},
    ${M.vEmpresa},
    ${M.cNombre},
    ${M.cPoblacion},
    ${M.cProvincia},
    ${M.cBloqueado},

    // ── Ventas: todas las lineas. El importe facturado es fiable. ──
    "VentaSem", CALCULATE(SUM(${M.vBase}), ${M.vFecha} >= _iniSem && ${M.vFecha} <= _hoy),
    "VentaMes", CALCULATE(SUM(${M.vBase}), ${M.vFecha} >= _iniMes && ${M.vFecha} <= _hoy),
    "VentaYTD", CALCULATE(SUM(${M.vBase}), ${M.vFecha} >= _iniAno && ${M.vFecha} <= _hoy),
    "Venta12m", CALCULATE(SUM(${M.vBase}), ${M.vFecha} >= _12m    && ${M.vFecha} <= _hoy),

    // ── Margen: SOLO lineas con coste creible. ──
    // Se descartan dos errores de maestro de articulos:
    //   1) coste vacio  -> daria 100% de margen
    //   2) coste absurdo -> ej. articulo a 0,58 EUR con coste 400,40 EUR,
    //      que genera margenes de -68.000%
    // El umbral de 3x el importe deja pasar ventas a perdida reales
    // y corta solo los errores evidentes.
    "VentaMesOk", CALCULATE(SUM(${M.vBase}),
      FILTER(${M.ventas},
        ${M.vFecha} >= _iniMes && ${M.vFecha} <= _hoy &&
        NOT ISBLANK(${M.vCoste}) &&
        ABS(${M.vCoste}) <= ABS(${M.vBase}) * 3)),
    "CosteMesOk", CALCULATE(SUM(${M.vCoste}),
      FILTER(${M.ventas},
        ${M.vFecha} >= _iniMes && ${M.vFecha} <= _hoy &&
        NOT ISBLANK(${M.vCoste}) &&
        ABS(${M.vCoste}) <= ABS(${M.vBase}) * 3)),

    "VentaYTDOk", CALCULATE(SUM(${M.vBase}),
      FILTER(${M.ventas},
        ${M.vFecha} >= _iniAno && ${M.vFecha} <= _hoy &&
        NOT ISBLANK(${M.vCoste}) &&
        ABS(${M.vCoste}) <= ABS(${M.vBase}) * 3)),
    "CosteYTDOk", CALCULATE(SUM(${M.vCoste}),
      FILTER(${M.ventas},
        ${M.vFecha} >= _iniAno && ${M.vFecha} <= _hoy &&
        NOT ISBLANK(${M.vCoste}) &&
        ABS(${M.vCoste}) <= ABS(${M.vBase}) * 3)),

    "Venta12mOk", CALCULATE(SUM(${M.vBase}),
      FILTER(${M.ventas},
        ${M.vFecha} >= _12m && ${M.vFecha} <= _hoy &&
        NOT ISBLANK(${M.vCoste}) &&
        ABS(${M.vCoste}) <= ABS(${M.vBase}) * 3)),
    "Coste12mOk", CALCULATE(SUM(${M.vCoste}),
      FILTER(${M.ventas},
        ${M.vFecha} >= _12m && ${M.vFecha} <= _hoy &&
        NOT ISBLANK(${M.vCoste}) &&
        ABS(${M.vCoste}) <= ABS(${M.vBase}) * 3)),

    "UltimaVenta", CALCULATE(MAX(${M.vFecha}))
  )
  ORDER BY [Venta12m] DESC`,

    // Variante de respaldo: sin datos de la tabla de clientes.
    ventasSimple: `
DEFINE
  VAR _hoy = TODAY()
  VAR _desde = _hoy - ${DIAS_HISTORICO}
  VAR _iniMes = DATE(YEAR(_hoy), MONTH(_hoy), 1)
EVALUATE
  SUMMARIZECOLUMNS(
    ${M.vCliente},
    ${M.vVendedor},
    ${M.vEmpresa},
    "VentasAno", CALCULATE(SUM(${M.vBase}),  ${M.vFecha} >= _desde  && ${M.vFecha} <= _hoy),
    "CosteAno",  CALCULATE(SUM(${M.vCoste}), ${M.vFecha} >= _desde  && ${M.vFecha} <= _hoy),
    "VentasMes", CALCULATE(SUM(${M.vBase}),  ${M.vFecha} >= _iniMes && ${M.vFecha} <= _hoy),
    "CosteMes",  CALCULATE(SUM(${M.vCoste}), ${M.vFecha} >= _iniMes && ${M.vFecha} <= _hoy),
    "UltimaVenta", CALCULATE(MAX(${M.vFecha}))
  )
  ORDER BY [VentasAno] DESC`,

    // 2) Pendiente de servir: por ARTICULO y unidades.
    //    Esta tabla no tiene cliente ni importe.
    pendiente: `
EVALUATE
  SUMMARIZECOLUMNS(
    ${M.pCodigo},
    ${M.pEstado},
    "Unidades", SUM(${M.pUni}),
    "Lineas",   COUNTROWS(${M.pendiente})
  )`,

    // 3) Stock: DESACTIVADO. La tabla '00 Stock' no tiene columna de
    //    cantidad (solo CODIGO, ALMACEN, FECHA, Empresa), asi que de
    //    momento solo se cuentan registros por articulo y almacen.
    stock: `
EVALUATE
  SUMMARIZECOLUMNS(
    '00 Stock'[CODIGO],
    '00 Stock'[ALMACEN],
    "Registros", COUNTROWS('00 Stock')
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
    client_id: ENV.PBI_CLIENT_ID,
    scope: "https://analysis.windows.net/powerbi/api/.default",
  };

  let body, modo;
  if (ENV.PBI_USER && ENV.PBI_PASS) {
    // MODO USUARIO (ROPC). Se autentica como persona, no como aplicacion.
    // Necesario porque los service principals no pueden consultar modelos
    // con RLS. Al usuario, si es Miembro/Admin del workspace, el RLS no
    // se le aplica y ve el total.
    //
    // AVISO: flujo deprecado por Microsoft. No funciona si la cuenta
    // tiene MFA, acceso condicional, ADFS o inicio sin contrasena.
    modo = "usuario";
    body = new URLSearchParams({
      ...base,
      grant_type: "password",
      username: ENV.PBI_USER,
      password: ENV.PBI_PASS,
      ...(ENV.PBI_CLIENT_SECRET ? { client_secret: ENV.PBI_CLIENT_SECRET } : {}),
    });
  } else if (ENV.PBI_CLIENT_SECRET) {
    modo = "secreto";
    body = new URLSearchParams({
      ...base,
      grant_type: "client_credentials",
      client_secret: ENV.PBI_CLIENT_SECRET,
    });
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
      grant_type: "client_credentials",
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
async function pbiQuery(token, query, incluirNulos = false) {
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
      // Con includeNulls a false, las columnas vacias en una fila
      // desaparecen del JSON y parece que no existen en el modelo.
      // Para inspeccionar esquema hay que pedirlas todas.
      serializerSettings: { includeNulls: incluirNulos },
    }),
  });

  const bruto = await r.text();
  let j = null;
  try { j = JSON.parse(bruto); } catch { /* respuesta no JSON */ }

  if (!r.ok) {
    // Power BI devuelve el motivo real en cabeceras propias, no en el cuerpo.
    // Sin esto solo se ve "401" y es imposible saber si falta un permiso,
    // si el tenant lo bloquea o si el modelo tiene RLS.
    const pistas = {
      status: r.status,
      errorInfo: r.headers.get("x-powerbi-error-info"),
      wwwAuth: r.headers.get("www-authenticate"),
      requestId: r.headers.get("requestid") || r.headers.get("x-ms-request-id"),
      codigo: j?.error?.code || j?.error?.["pbi.error"]?.code,
      detalle: j?.error?.["pbi.error"]?.details?.[0]?.detail?.value || j?.error?.message,
      // El motivo real (nombre de columna mal, medida inexistente...) suele
      // venir mas abajo, en un detalle anidado que es facil pasar por alto.
      detalleDax: JSON.stringify(j?.error?.["pbi.error"]?.details || j?.error?.details || "")
        .slice(0, 600) || undefined,
      cuerpo: j ? undefined : bruto.slice(0, 300),
    };
    const e = new Error(
      Object.entries(pistas)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .join(" | ")
    );
    e.pistas = pistas;
    throw e;
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

// Lee la coleccion "clientes" del CRM para saber que comercial tiene
// asignado cada cliente. Es la unica fuente fiable: el codigo de vendedor
// que trae Power BI ("1201", "6668") no se corresponde con los agentes
// del CRM (AZARCO, CARLOSG...).
async function fbLeerClientes() {
  const base = `projects/${ENV.FB_PROJECT_ID}/databases/(default)/documents`;
  const key = ENV.FB_API_KEY ? `&key=${ENV.FB_API_KEY}` : "";
  const mapa = new Map();
  let pageToken = null, vueltas = 0;

  do {
    const url = `https://firestore.googleapis.com/v1/${base}/clientes` +
                `?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ""}${key}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`leer clientes: HTTP ${r.status}`);
    const j = await r.json();
    for (const d of j.documents || []) {
      const f = d.fields || {};
      const val = (k) => f[k]?.stringValue ?? f[k]?.integerValue ?? null;
      const codigo = val("CODIGO") || val("codigo") || d.name.split("/").pop();
      const agente = val("GRUPOAGENTE") || val("grupoAgente") || val("agente");
      if (codigo && agente) mapa.set(String(codigo).trim(), String(agente).trim());
    }
    pageToken = j.nextPageToken || null;
    vueltas++;
  } while (pageToken && vueltas < 60);

  return mapa;
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
      const enWs = ws.some((g) => g.id === ENV.PBI_GROUP_ID);

      // Segunda comprobacion: que modelos semanticos hay DENTRO del
      // workspace, y si el dataset que buscamos esta realmente ahi.
      // Si el modelo vive en otro workspace y solo esta compartido,
      // executeQueries devuelve 401 aunque el workspace se vea bien.
      let ds = null, dsError = null;
      if (enWs) {
        try {
          const r2 = await fetch(
            `https://api.powerbi.com/v1.0/myorg/groups/${ENV.PBI_GROUP_ID}/datasets`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          const j2 = await r2.json();
          if (!r2.ok) throw new Error(j2.error?.message || `HTTP ${r2.status}`);
          ds = (j2.value || []).map((d) => ({
            id: d.id,
            nombre: d.name,
            permisoQuery: d.queryScaleOutSettings === undefined ? undefined : undefined,
          }));
        } catch (e) {
          dsError = e.message;
        }
      }

      const dsEncontrado = ds ? ds.some((d) => d.id === ENV.PBI_DATASET_ID) : null;

      let diagnostico;
      if (ws.length === 0) {
        diagnostico = "El service principal no ve NINGUN workspace. Falta el ajuste de tenant o el grupo de seguridad.";
      } else if (!enWs) {
        diagnostico = "El SP ve workspaces pero NO el de UNITED. Falta anadirlo a ese workspace.";
      } else if (dsError) {
        diagnostico = `Workspace OK, pero no se pueden listar sus modelos: ${dsError}`;
      } else if (dsEncontrado === false) {
        diagnostico = "AQUI ESTA EL PROBLEMA: el dataset buscado NO esta en este workspace. " +
                      "Mira la lista 'datasetsEnWorkspace' y usa el id correcto, o el modelo vive en otro workspace.";
      } else if (dsEncontrado === true) {
        diagnostico = "Workspace y dataset correctos. Si executeQueries da 401, falta permiso Build " +
                      "sobre el modelo (rol Viewer no basta) o el ajuste de Execute Queries no ha propagado.";
      }

      return res.status(200).json({
        ok: true,
        modoAuth: modo,
        workspacesVisibles: ws.length,
        workspaces: ws,
        buscado: ENV.PBI_GROUP_ID,
        encontrado: enWs,
        datasetBuscado: ENV.PBI_DATASET_ID,
        datasetEncontrado: dsEncontrado,
        datasetsEnWorkspace: ds,
        datasetsError: dsError,
        diagnostico,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ?schema=1 → pregunta al propio modelo como se llama todo.
  // Elimina el adivinar nombres: devuelve la lista real de medidas y
  // columnas segun el motor. Usar en cuanto haya permisos.
  if (req.query.schema === "1") {
    const out = { ok: true };
    try {
      const { token, modo } = await getToken(req);
      out.modoAuth = modo;
      // Varias formas de preguntar lo mismo. Los modelos antiguos no
      // tienen INFO.*, y los de Fabric a veces solo INFO.VIEW.*.
      // Se prueban en orden y se queda la primera que responda.
      const variantes = {
        medidas: [
          "EVALUATE INFO.VIEW.MEASURES()",
          "EVALUATE INFO.MEASURES()",
          'EVALUATE SELECTCOLUMNS(INFO.MEASURES(), "medida", [Name])',
        ],
        tablas: [
          "EVALUATE INFO.VIEW.TABLES()",
          "EVALUATE INFO.TABLES()",
        ],
        columnas: [
          "EVALUATE INFO.VIEW.COLUMNS()",
          "EVALUATE INFO.COLUMNS()",
        ],
      };
      for (const [k, lista] of Object.entries(variantes)) {
        const fallos = [];
        for (const q of lista) {
          try {
            const filas = await pbiQuery(token, q);
            out[k] = { consultaQueFunciono: q, filas: filas.slice(0, 400) };
            break;
          } catch (e) {
            fallos.push(`${q.slice(0, 40)} -> ${e.message.slice(0, 120)}`);
          }
        }
        if (!out[k]) out[k] = { error: "ninguna variante funciono", intentos: fallos };
      }
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
    return res.status(200).json(out);
  }

  // ?peek=1 → trae UNA fila de cada tabla.
  // Truco que no depende de las funciones INFO.*: la respuesta incluye
  // todas las columnas como claves, y un valor de ejemplo de cada una,
  // asi que revela nombres exactos Y tipos de dato de golpe.
  if (req.query.peek === "1") {
    const out = { ok: true };
    try {
      const { token, modo } = await getToken(req);
      out.modoAuth = modo;
      const tablas = {
        ventas:    M.ventas,
        pendiente: M.pendiente,
        stock:     M.stock,
        clientes:  M.clientes,
      };
      for (const [k, tabla] of Object.entries(tablas)) {
        try {
          const filas = await pbiQuery(token, `EVALUATE TOPN(1, ${tabla})`, true);
          const fila = filas[0] || {};
          out[k] = {
            tabla,
            columnas: Object.keys(fila).map((c) => ({
              nombre: c,
              ejemplo: fila[c],
              tipo: typeof fila[c],
            })),
          };
        } catch (e) {
          out[k] = { tabla, error: e.message.slice(0, 250) };
        }
      }
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
    return res.status(200).json(out);
  }

  // ?audit=1 → busca las filas que rompen el margen.
  //   &agente=DAVIDMAG  limita a los clientes de ese comercial (opcional)
  //   &cliente=B430088  salta directo al detalle de linea de ese cliente
  //
  // Existe porque el margen calculado como BASE - Costo Referencia da
  // valores imposibles en algunos comerciales, mientras que en otros
  // cuadra al decimal. La causa tiene que estar en filas concretas.
  if (req.query.audit === "1") {
    const out = { ok: true };
    try {
      const { token } = await getToken(req);
      const T = M.ventas;

      // A) Los 15 clientes con el coste mas desproporcionado respecto a venta
      out.peoresClientes = await pbiQuery(token, `
EVALUATE
  TOPN(
    15,
    FILTER(
      SUMMARIZECOLUMNS(
        ${M.vCliente},
        ${M.cNombre},
        "Venta",  SUM(${M.vBase}),
        "Coste",  SUM(${M.vCoste}),
        "Unidades", SUM(${T}[UNI]),
        "Lineas",   COUNTROWS(${T})
      ),
      [Coste] > [Venta] * 1.5
    ),
    [Coste] - [Venta], DESC
  )`);

      // B) Detalle de linea del cliente indicado, o del peor de la lista
      const cli = req.query.cliente ||
        (out.peoresClientes?.[0] ? pick(out.peoresClientes[0], "CLIENTE") : null);
      out.clienteAnalizado = cli;

      if (cli) {
        out.lineas = await pbiQuery(token, `
EVALUATE
  TOPN(
    20,
    SELECTCOLUMNS(
      FILTER(${T}, ${M.vCliente} = "${String(cli).replace(/"/g, "")}"),
      "Articulo", ${T}[CODIGO],
      "Fecha",    ${T}[FECHA],
      "Uni",      ${T}[UNI],
      "MetrosTexto", ${T}[METROS],
      "Precio",   ${T}[PRECIO],
      "Base",     ${M.vBase},
      "CosteUnit",${T}[COSTOREFERENCIA],
      "CosteLinea", ${M.vCoste},
      "MargenPctFila", ${T}[Margen Referencia por fila]
    ),
    [CosteLinea] - [Base], DESC
  )`, true);
      }

      // C bis) Articulos con coste de referencia incoherente.
      // Compara precio medio de venta contra coste medio del maestro.
      // Un ratio de 3x o mas es un error de maestro, no un producto
      // vendido a perdida. Esta lista es la que hay que pasar a sistemas.
      out.articulosDefectuosos = await pbiQuery(token, `
EVALUATE
  TOPN(
    40,
    FILTER(
      SUMMARIZECOLUMNS(
        ${T}[CODIGO],
        "PrecioMedio", AVERAGE(${T}[PRECIO]),
        "CosteMedio",  AVERAGE(${T}[COSTOREFERENCIA]),
        "Lineas",      COUNTROWS(${T}),
        "VentaTotal",  SUM(${M.vBase}),
        "CosteTotal",  SUM(${M.vCoste})
      ),
      [PrecioMedio] > 0 && [CosteMedio] > [PrecioMedio] * 3
    ),
    [CosteTotal], DESC
  )`);

      // C ter) Cuanta venta no tiene coste de referencia asignado
      out.sinCoste = await pbiQuery(token, `
EVALUATE
  ROW(
    "VentaSinCoste", CALCULATE(SUM(${M.vBase}), FILTER(${T}, ISBLANK(${M.vCoste}))),
    "LineasSinCoste", CALCULATE(COUNTROWS(${T}), FILTER(${T}, ISBLANK(${M.vCoste}))),
    "VentaTotal", SUM(${M.vBase}),
    "LineasTotal", COUNTROWS(${T})
  )`);

      // C) Comparacion global: lo que suma el modelo frente a lo que sumo yo
      out.totales = await pbiQuery(token, `
EVALUATE
  ROW(
    "VentaTotal",  SUM(${M.vBase}),
    "CosteTotal",  SUM(${M.vCoste}),
    "MargenCalc",  SUM(${M.vBase}) - SUM(${M.vCoste}),
    "MargenPctCalc", DIVIDE(SUM(${M.vBase}) - SUM(${M.vCoste}), SUM(${M.vBase})) * 100,
    "MargenPctFilaProm", AVERAGE(${T}[Margen Referencia por fila]),
    "Lineas", COUNTROWS(${T})
  )`);

    } catch (e) {
      out.ok = false;
      out.error = e.message;
    }
    return res.status(200).json(out);
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
      let filas, enriquecido = true;
      try {
        filas = await pbiQuery(token, Q.ventas);
      } catch (e) {
        // Sin relacion entre ventas y clientes en el modelo: se cae a la
        // version sin nombre en lugar de perder el bloque entero.
        log.avisoVentas = `sin datos de cliente (${e.message.slice(0, 120)})`;
        enriquecido = false;
        filas = await pbiQuery(token, Q.ventasSimple);
      }
      log.ventasEnriquecido = enriquecido;
      const docs = filas.map((r) => {
        const cliente = pick(r, "CLIENTE");
        const vSem = num(pick(r, "VentaSem"));
        const vMes = num(pick(r, "VentaMes"));
        const vYTD = num(pick(r, "VentaYTD"));
        const v12m = num(pick(r, "Venta12m"));

        // Base "limpia" para el margen: solo lineas con coste creible
        const vMesOk = num(pick(r, "VentaMesOk"));
        const vYTDOk = num(pick(r, "VentaYTDOk"));
        const v12mOk = num(pick(r, "Venta12mOk"));
        const mMes = num(vMesOk - num(pick(r, "CosteMesOk")));
        const mYTD = num(vYTDOk - num(pick(r, "CosteYTDOk")));
        const m12m = num(v12mOk - num(pick(r, "Coste12mOk")));

        // Porcentaje de la venta que tiene coste fiable. Si es bajo,
        // el margen de ese cliente no es representativo.
        const cob = (ok, tot) => (tot ? num((100 * ok) / tot) : 0);

        return {
          _id: docId(cliente),
          cliente,
          nombre: pick(r, "NOMBRE") || cliente,
          intercompany: esIntercompany(pick(r, "NOMBRE")),
          poblacion: pick(r, "POBLACION"),
          provincia: pick(r, "PROVINCIA"),
          bloqueado: pick(r, "BLQ") === "SI",
          vendedor: pick(r, "VENDEDOR"),
          empresa: pick(r, "EMPRESA"),

          ventasSem: vSem,
          ventasMes: vMes,
          ventasYTD: vYTD,
          ventasAno: v12m,

          margenMes: mMes,
          margenYTD: mYTD,
          margenAno: m12m,
          margenPctMes: vMesOk ? num((100 * mMes) / vMesOk) : null,
          margenPctYTD: vYTDOk ? num((100 * mYTD) / vYTDOk) : null,
          margenPctAno: v12mOk ? num((100 * m12m) / v12mOk) : null,

          coberturaMes: cob(vMesOk, vMes),
          coberturaYTD: cob(vYTDOk, vYTD),
          coberturaAno: cob(v12mOk, v12m),

          ultimaVenta: pick(r, "UltimaVenta"),
          actualizado: new Date().toISOString(),
        };
      });

      log.intercompanyMarcados = docs.filter((d) => d.intercompany).length;

      // ── Resumen por comercial, para el dashboard ──
      // Se cruza cada cliente con su grupoAgente segun el CRM y se suman
      // las cuatro ventanas. Asi el dashboard lee 10 documentos en vez de
      // los 6.589 de clientes.
      try {
        const asignacion = await fbLeerClientes();
        log.clientesCrmLeidos = asignacion.size;

        const porAgente = new Map();
        let sinAsignar = 0;

        for (const d of docs) {
          if (d.intercompany) continue;           // fuera traspasos internos
          const agente = asignacion.get(String(d.cliente).trim());
          if (!agente) { sinAsignar++; continue; }
          if (!porAgente.has(agente)) {
            porAgente.set(agente, {
              _id: docId(agente), agente,
              ventasSem: 0,
              ventasMes: 0, margenMes: 0, baseMes: 0,
              ventasYTD: 0, margenYTD: 0, baseYTD: 0,
              ventasAno: 0, margenAno: 0, baseAno: 0,
              clientes: 0, clientesConVentaMes: 0,
            });
          }
          const a = porAgente.get(agente);
          a.ventasSem += d.ventasSem;
          a.ventasMes += d.ventasMes; a.margenMes += d.margenMes;
          a.ventasYTD += d.ventasYTD; a.margenYTD += d.margenYTD;
          a.ventasAno += d.ventasAno; a.margenAno += d.margenAno;
          // base limpia = venta con coste fiable, reconstruida desde cobertura
          a.baseMes += d.ventasMes * (d.coberturaMes / 100);
          a.baseYTD += d.ventasYTD * (d.coberturaYTD / 100);
          a.baseAno += d.ventasAno * (d.coberturaAno / 100);
          a.clientes++;
          if (d.ventasMes > 0) a.clientesConVentaMes++;
        }

        const resumen = [...porAgente.values()].map((a) => {
          const p = (m, v) => (v ? num((100 * m) / v) : null);
          return {
            ...a,
            ventasSem: num(a.ventasSem),
            ventasMes: num(a.ventasMes), margenMes: num(a.margenMes),
            ventasYTD: num(a.ventasYTD), margenYTD: num(a.margenYTD),
            ventasAno: num(a.ventasAno), margenAno: num(a.margenAno),
            // El % se calcula sobre la venta con coste fiable, no sobre
            // la venta total. Si no, saldria diluido.
            margenPctMes: p(a.margenMes, a.baseMes),
            margenPctYTD: p(a.margenYTD, a.baseYTD),
            margenPctAno: p(a.margenAno, a.baseAno),
            coberturaMes: a.ventasMes ? num(100 * a.baseMes / a.ventasMes) : 0,
            coberturaYTD: a.ventasYTD ? num(100 * a.baseYTD / a.ventasYTD) : 0,
            coberturaAno: a.ventasAno ? num(100 * a.baseAno / a.ventasAno) : 0,
            baseMes: num(a.baseMes), baseYTD: num(a.baseYTD), baseAno: num(a.baseAno),
          };
        });

        // Fila total, para los KPI de cabecera del dashboard
        const tot = resumen.reduce((t, a) => {
          for (const k of ["ventasSem","ventasMes","margenMes","baseMes",
                           "ventasYTD","margenYTD","baseYTD",
                           "ventasAno","margenAno","baseAno",
                           "clientes","clientesConVentaMes"]) t[k] += a[k];
          return t;
        }, { _id: "_TOTAL", agente: "_TOTAL", ventasSem:0,
             ventasMes:0, margenMes:0, baseMes:0,
             ventasYTD:0, margenYTD:0, baseYTD:0,
             ventasAno:0, margenAno:0, baseAno:0,
             clientes:0, clientesConVentaMes:0 });
        const p = (m, v) => (v ? num((100 * m) / v) : null);
        tot.margenPctMes = p(tot.margenMes, tot.baseMes);
        tot.margenPctYTD = p(tot.margenYTD, tot.baseYTD);
        tot.margenPctAno = p(tot.margenAno, tot.baseAno);
        tot.coberturaAno = tot.ventasAno ? num(100 * tot.baseAno / tot.ventasAno) : 0;
        resumen.push(tot);

        log.agentes = resumen.length - 1;
        log.clientesSinAgente = sinAsignar;
        log.resumenAgentes = dry
          ? resumen
          : await fbCommit("pbi_resumen_agente", resumen);
      } catch (e) {
        log.errores.push(`resumen: ${e.message}`);
      }

      log.ventas = dry ? docs.length : await fbCommit("pbi_ventas_cliente", docs);
      if (dry) log.muestraVentas = docs.slice(0, 3);
    } catch (e) {
      log.errores.push(`ventas: ${e.message}`);
    }

    // ── 2. Pendiente de servir (desactivado, ver ACTIVOS) ──
    if (activo("pendiente")) try {
      const filas = await pbiQuery(token, Q.pendiente);
      const docs = filas.map((r) => ({
        _id: docId(pick(r, "CODIGO")) + "_" + docId(pick(r, "ESTADO")),
        articulo: pick(r, "CODIGO"),
        estado: pick(r, "ESTADO"),
        unidades: num(pick(r, "Unidades")),
        lineas: num(pick(r, "Lineas")),
        actualizado: new Date().toISOString(),
      }));
      log.pendiente = dry ? docs.length : await fbCommit("pbi_pendiente_servir", docs);
      if (dry) log.muestraPendiente = docs.slice(0, 3);
    } catch (e) {
      log.errores.push(`pendiente: ${e.message}`);
    }
    else log.pendiente = "desactivado";

    // ── 3. Stock por referencia (desactivado, ver ACTIVOS) ──
    if (activo("stock")) try {
      const filas = await pbiQuery(token, Q.stock);
      const docs = filas.map((r) => ({
        _id: docId(pick(r, "CODIGO")) + "_" + docId(pick(r, "ALMACEN")),
        articulo: pick(r, "CODIGO"),
        almacen: pick(r, "ALMACEN"),
        registros: num(pick(r, "Registros")),
        actualizado: new Date().toISOString(),
      }));
      log.stock = dry ? docs.length : await fbCommit("pbi_stock", docs);
      if (dry) log.muestraStock = docs.slice(0, 3);
    } catch (e) {
      log.errores.push(`stock: ${e.message}`);
    }
    else log.stock = "desactivado";

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
