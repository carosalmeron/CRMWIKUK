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
  cCodconta:  "'00 Clientes Global'[CODCONTA]",
};

const DIAS_HISTORICO = 365;

// Bloques que se sincronizan de verdad. "stock" queda fuera a proposito:
// la tabla '00 Stock' no tiene columna de cantidad, asi que ahora mismo
// solo devolveria un recuento de registros (13.666 filas sin valor).
// Reactivar cuando sistemas indique donde vive el stock disponible.
const ACTIVOS = ["ventas", "pedidos"];

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
function dax(desde) {
  // Modo incremental: solo se recalculan los clientes que han tenido
  // movimiento desde la ultima sincronizacion. El resto conserva en
  // Firestore los valores del dia anterior, que no han cambiado.
  //
  // El filtro va como argumento de SUMMARIZECOLUMNS y no envolviendolo
  // en CALCULATETABLE, porque DAX no permite SUMMARIZECOLUMNS dentro de
  // un CALCULATETABLE que modifique el contexto de filtro.
  const filtroIncremental = desde
    ? `FILTER(VALUES(${M.vCliente}),
         CALCULATE(COUNTROWS(${M.ventas}),
           FILTER(${M.ventas}, ${M.vFecha} >= DATE(${desde.getFullYear()}, ${desde.getMonth() + 1}, ${desde.getDate()}))) > 0),`
    : "";
  return {
    // 1) Ventas, coste y margen por cliente: 12 meses + mes en curso.
    //    Se intenta primero enriqueciendo con nombre y poblacion desde
    //    '00 Clientes Global'. Si no existe relacion en el modelo, la
    //    consulta falla y se reintenta con la version simple (ventasSimple).
    ventas: `
DEFINE
  VAR _hoy = TODAY()
  VAR _anoAct = YEAR(_hoy)
  VAR _anoAnt = _anoAct - 1
  VAR _iniMes = DATE(YEAR(_hoy), MONTH(_hoy), 1)
  VAR _iniSem = _hoy - WEEKDAY(_hoy, 2) + 1
  // Mismo dia del ano pasado, para comparar periodos equivalentes
  VAR _corteAnt = DATE(_anoAnt, MONTH(_hoy), DAY(_hoy))
EVALUATE
  SUMMARIZECOLUMNS(
    ${M.vCliente},
    ${M.vVendedor},
    ${M.vEmpresa},
    ${filtroIncremental}

    // ── Ano anterior COMPLETO: dato de referencia que se guarda ──
    "VentaAntFull", CALCULATE(SUM(${M.vBase}),
      FILTER(${M.ventas}, YEAR(${M.vFecha}) = _anoAnt)),
    "VentaAntFullOk", CALCULATE(SUM(${M.vBase}),
      FILTER(${M.ventas}, YEAR(${M.vFecha}) = _anoAnt &&
        NOT ISBLANK(${M.vCoste}) && ABS(${M.vCoste}) <= ABS(${M.vBase}) * 3)),
    "CosteAntFullOk", CALCULATE(SUM(${M.vCoste}),
      FILTER(${M.ventas}, YEAR(${M.vFecha}) = _anoAnt &&
        NOT ISBLANK(${M.vCoste}) && ABS(${M.vCoste}) <= ABS(${M.vBase}) * 3)),

    // ── Ano anterior MISMO PERIODO: base de la comparativa ──
    "VentaAntYTD", CALCULATE(SUM(${M.vBase}),
      FILTER(${M.ventas}, YEAR(${M.vFecha}) = _anoAnt && ${M.vFecha} <= _corteAnt)),
    "VentaAntYTDOk", CALCULATE(SUM(${M.vBase}),
      FILTER(${M.ventas}, YEAR(${M.vFecha}) = _anoAnt && ${M.vFecha} <= _corteAnt &&
        NOT ISBLANK(${M.vCoste}) && ABS(${M.vCoste}) <= ABS(${M.vBase}) * 3)),
    "CosteAntYTDOk", CALCULATE(SUM(${M.vCoste}),
      FILTER(${M.ventas}, YEAR(${M.vFecha}) = _anoAnt && ${M.vFecha} <= _corteAnt &&
        NOT ISBLANK(${M.vCoste}) && ABS(${M.vCoste}) <= ABS(${M.vBase}) * 3)),

    // ── Ano en curso ──
    "VentaAct", CALCULATE(SUM(${M.vBase}),
      FILTER(${M.ventas}, YEAR(${M.vFecha}) = _anoAct)),
    "VentaActOk", CALCULATE(SUM(${M.vBase}),
      FILTER(${M.ventas}, YEAR(${M.vFecha}) = _anoAct &&
        NOT ISBLANK(${M.vCoste}) && ABS(${M.vCoste}) <= ABS(${M.vBase}) * 3)),
    "CosteActOk", CALCULATE(SUM(${M.vCoste}),
      FILTER(${M.ventas}, YEAR(${M.vFecha}) = _anoAct &&
        NOT ISBLANK(${M.vCoste}) && ABS(${M.vCoste}) <= ABS(${M.vBase}) * 3)),

    // Margen del mes y del mismo mes del ano pasado, con el mismo filtro de
    // coste limpio que el anual: sin esto no se puede saber si el margen del
    // mes mejora o empeora respecto al ano anterior.
    // Margen de la semana en curso: lo necesita el cierre semanal, que hasta
    // ahora obligaba al comercial a teclearlo de memoria.
    "VentaSemOk", CALCULATE(SUM(${M.vBase}),
      FILTER(${M.ventas}, ${M.vFecha} >= _iniSem && ${M.vFecha} <= _hoy &&
        NOT ISBLANK(${M.vCoste}) && ABS(${M.vCoste}) <= ABS(${M.vBase}) * 3)),
    "CosteSemOk", CALCULATE(SUM(${M.vCoste}),
      FILTER(${M.ventas}, ${M.vFecha} >= _iniSem && ${M.vFecha} <= _hoy &&
        NOT ISBLANK(${M.vCoste}) && ABS(${M.vCoste}) <= ABS(${M.vBase}) * 3)),

    "VentaMesOk", CALCULATE(SUM(${M.vBase}),
      FILTER(${M.ventas}, ${M.vFecha} >= _iniMes && ${M.vFecha} <= _hoy &&
        NOT ISBLANK(${M.vCoste}) && ABS(${M.vCoste}) <= ABS(${M.vBase}) * 3)),
    "CosteMesOk", CALCULATE(SUM(${M.vCoste}),
      FILTER(${M.ventas}, ${M.vFecha} >= _iniMes && ${M.vFecha} <= _hoy &&
        NOT ISBLANK(${M.vCoste}) && ABS(${M.vCoste}) <= ABS(${M.vBase}) * 3)),
    "VentaMesAntOk", CALCULATE(SUM(${M.vBase}),
      FILTER(${M.ventas}, YEAR(${M.vFecha}) = _anoAnt && MONTH(${M.vFecha}) = MONTH(_hoy)
        && DAY(${M.vFecha}) <= DAY(_hoy) &&
        NOT ISBLANK(${M.vCoste}) && ABS(${M.vCoste}) <= ABS(${M.vBase}) * 3)),
    "CosteMesAntOk", CALCULATE(SUM(${M.vCoste}),
      FILTER(${M.ventas}, YEAR(${M.vFecha}) = _anoAnt && MONTH(${M.vFecha}) = MONTH(_hoy)
        && DAY(${M.vFecha}) <= DAY(_hoy) &&
        NOT ISBLANK(${M.vCoste}) && ABS(${M.vCoste}) <= ABS(${M.vBase}) * 3)),

    "VentaMes", CALCULATE(SUM(${M.vBase}), ${M.vFecha} >= _iniMes && ${M.vFecha} <= _hoy),
    "VentaSem", CALCULATE(SUM(${M.vBase}), ${M.vFecha} >= _iniSem && ${M.vFecha} <= _hoy),
    // Mismo mes y misma semana del ano pasado, para poder comparar cuando
    // no hay presupuesto cargado. Sin esto el CRM solo puede medir contra
    // objetivo, y si el objetivo esta a cero no hay referencia ninguna.
    "VentaMesAnt", CALCULATE(SUM(${M.vBase}),
      FILTER(${M.ventas}, YEAR(${M.vFecha}) = _anoAnt && MONTH(${M.vFecha}) = MONTH(_hoy)
        && DAY(${M.vFecha}) <= DAY(_hoy))),
    "VentaSemAnt", CALCULATE(SUM(${M.vBase}),
      FILTER(${M.ventas}, ${M.vFecha} >= _iniSem - 364 && ${M.vFecha} <= _corteAnt)),
    "UltimaVenta", CALCULATE(MAX(${M.vFecha}))
  )
  ORDER BY [VentaAct] DESC`,

    // Pedidos con entrega planificada de hoy en adelante. Es lo que un
    // comercial necesita ver: cuando le va a salir cada pedido.
    // Solo futuro: la tabla conserva entregas desde 2017 sin purgar.
    pedidos: `
DEFINE
  VAR _hoy = TODAY()
EVALUATE
  SELECTCOLUMNS(
    FILTER('00 Pedidos Validados Global',
      '00 Pedidos Validados Global'[FECHAPLANIFICADA] >= _hoy),
    "Cliente",  '00 Pedidos Validados Global'[CLIENTE],
    "Vendedor", '00 Pedidos Validados Global'[VENDEDOR],
    "Fecha",    '00 Pedidos Validados Global'[FECHAPLANIFICADA],
    "Articulo", '00 Pedidos Validados Global'[CODIGO],
    "Familia",  '00 Pedidos Validados Global'[FAMILIA],
    "Uni",      '00 Pedidos Validados Global'[UNI],
    "Precio",   '00 Pedidos Validados Global'[PRECIO],
    "Subfamilia",'00 Pedidos Validados Global'[SUBFAMILIA],
    "Importe",  '00 Pedidos Validados Global'[BASE],
    "Pedido",   '00 Pedidos Validados Global'[NumPedido]
  )`,

    // Dimension de clientes en consulta SEPARADA.
    // Antes iba dentro del SUMMARIZECOLUMNS de ventas, pero la tabla
    // tiene codigos repetidos (una fila por sociedad) y eso multiplicaba
    // las filas de resultado. Aqui se trae una vez y se cruza en JS.
    clientes: `
EVALUATE
  SUMMARIZECOLUMNS(
    ${M.clientes}[CODIGO],
    ${M.cNombre},
    ${M.cPoblacion},
    ${M.cProvincia},
    ${M.cBloqueado},
    ${M.cCodconta}
  )`,

    // Entrada de pedidos por vendedor, por FECHA de pedido (no de entrega).
    // Mide el trabajo comercial de la semana, que es lo que el vendedor
    // controla: la factura llega semanas despues.
    entrada: `
DEFINE
  VAR _hoy = TODAY()
  VAR _iniSem = _hoy - WEEKDAY(_hoy, 2) + 1
  VAR _iniMes = DATE(YEAR(_hoy), MONTH(_hoy), 1)
  VAR _anoAct = YEAR(_hoy)
  VAR _anoAnt = _anoAct - 1
  VAR _corteAnt = DATE(_anoAnt, MONTH(_hoy), DAY(_hoy))
EVALUATE
  SUMMARIZECOLUMNS(
    '00 Entrada Pedidos Global'[VENDEDOR],
    "Sem", CALCULATE(SUM('00 Entrada Pedidos Global'[BASE]),
      '00 Entrada Pedidos Global'[FECHA] >= _iniSem &&
      '00 Entrada Pedidos Global'[FECHA] <= _hoy),
    "Mes", CALCULATE(SUM('00 Entrada Pedidos Global'[BASE]),
      '00 Entrada Pedidos Global'[FECHA] >= _iniMes &&
      '00 Entrada Pedidos Global'[FECHA] <= _hoy),
    "Ano", CALCULATE(SUM('00 Entrada Pedidos Global'[BASE]),
      FILTER('00 Entrada Pedidos Global',
        YEAR('00 Entrada Pedidos Global'[FECHA]) = _anoAct)),
    "SemAnt", CALCULATE(SUM('00 Entrada Pedidos Global'[BASE]),
      '00 Entrada Pedidos Global'[FECHA] >= _iniSem - 364 &&
      '00 Entrada Pedidos Global'[FECHA] <= _corteAnt),
    "AnoAnt", CALCULATE(SUM('00 Entrada Pedidos Global'[BASE]),
      FILTER('00 Entrada Pedidos Global',
        YEAR('00 Entrada Pedidos Global'[FECHA]) = _anoAnt &&
        '00 Entrada Pedidos Global'[FECHA] <= _corteAnt))
  )`,

    // Maestro de articulos: descripcion, metros y calibre. La tabla de
    // pedidos solo trae el codigo, asi que sin esto el comercial ve
    // "ESP60.10" en vez de saber que producto va a salir.
    articulos: `
EVALUATE
  SUMMARIZECOLUMNS(
    '00 Plu Global'[CODIGO],
    '00 Plu Global'[DESCRIPCION],
    '00 Plu Global'[METROS],
    '00 Plu Global'[CALIBRE],
    '00 Plu Global'[CALIDAD]
  )`,

    // Tabla Agentes: traduce el codigo de vendedor del ERP al comercial
    // (GRUPOAGENTE) y marca la intercompania (GRUPONIVEL1). Es la misma
    // logica que usa el Panel Principal, asi que las cifras cuadran.
    agentes: `
EVALUATE
  SUMMARIZECOLUMNS(
    'Agentes'[CODIGO],
    'Agentes'[GRUPOAGENTE],
    'Agentes'[GRUPONIVEL1],
    'Agentes'[GRUPONIVEL2],
    'Agentes'[GRUPONIVEL3],
    'Agentes'[GRUPONIVEL4],
    'Agentes'[MB]
  )`,

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
      const conta = val("CODCONTA") || val("codconta");
      if (!agente) continue;
      if (codigo) {
        const cod = String(codigo).trim();
        mapa.set(cod, String(agente).trim());
        // El CRM guarda los codigos antiguos; Power BI ya usa los nuevos.
        const can = canonico(cod);
        if (can !== cod && !mapa.has(can)) mapa.set(can, String(agente).trim());
      }
      // Segundo indice por codigo contable: en 2026 se recodificaron
      // clientes (serie U4... -> C0...) y el codigo nuevo no esta en el
      // CRM, pero el contable no cambia.
      if (conta) mapa.set("CC:" + String(conta).trim(), String(agente).trim());
    }
    pageToken = j.nextPageToken || null;
    vueltas++;
  } while (pageToken && vueltas < 60);

  return mapa;
}

// Lee todos los documentos de una coleccion. Se usa para recalcular el
// resumen por comercial: las lecturas son mucho mas baratas que las
// escrituras, asi que compensa releer y escribir solo los ~55 agregados.
async function fbLeerDocumento(coleccion, id) {
  const base = `projects/${ENV.FB_PROJECT_ID}/databases/(default)/documents`;
  const key = ENV.FB_API_KEY ? `?key=${ENV.FB_API_KEY}` : "";
  const r = await fetch(`https://firestore.googleapis.com/v1/${base}/${coleccion}/${id}${key}`);
  if (!r.ok) return null;
  const j = await r.json();
  const o = {};
  for (const [k, v] of Object.entries(j.fields || {})) {
    o[k] = v.stringValue ?? v.doubleValue ?? v.integerValue ?? v.booleanValue ?? null;
  }
  return o;
}

async function fbLeerColeccion(coleccion) {
  const base = `projects/${ENV.FB_PROJECT_ID}/databases/(default)/documents`;
  const key = ENV.FB_API_KEY ? `&key=${ENV.FB_API_KEY}` : "";
  const docs = [];
  let pageToken = null, vueltas = 0;
  do {
    const url = `https://firestore.googleapis.com/v1/${base}/${coleccion}` +
                `?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ""}${key}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`leer ${coleccion}: HTTP ${r.status}`);
    const j = await r.json();
    for (const d of j.documents || []) {
      const o = { _id: d.name.split("/").pop() };
      for (const [k, v] of Object.entries(d.fields || {})) {
        o[k] = v.doubleValue ?? v.integerValue ?? v.stringValue ??
               v.booleanValue ?? null;
        if (o[k] !== null && v.integerValue !== undefined) o[k] = Number(o[k]);
        if (v.doubleValue !== undefined) o[k] = Number(v.doubleValue);
      }
      docs.push(o);
    }
    pageToken = j.nextPageToken || null;
    vueltas++;
  } while (pageToken && vueltas < 60);
  return docs;
}

// Recodificacion de 2026: los codigos U43+4digitos pasaron a U43+0+esos
// 4 digitos. Verificado cruzando nombres (U433509 -> U4303509 WIKUK EASY,
// U434210 -> U4304210 LORIENTE PIQUERAS, U431880 -> U4301880 MANACOR).
// El historico de ventas y el CRM conservan el codigo viejo.
// La regla se puede sobrescribir desde Firestore (pbi_config/reglas):
//   recodPrefijo="U43", recodDigitos=4, recodInserta="0"
// Lo de aqui es solo el valor por defecto verificado en julio de 2026.
let RECOD = { prefijo: "U43", digitos: 4, inserta: "0" };

// ── Ramas comerciales ──────────────────────────────────────────────
// Se calculan aqui una sola vez y se escriben en pbi_resumen_agente, para
// que el CRM y las paginas de analisis no tengan que repetir la regla.
// Editable en Firestore: pbi_config/ramas
// ── Equivalencias de artículos ─────────────────────────────────────
// Al cambiar la codificación, un artículo vendido el año pasado como US45.70
// hoy se factura como IR18.7N. Sin traducir, el análisis muestra el antiguo
// perdiendo el 100% y el nuevo creciendo desde cero: dos falsos movimientos
// por cada artículo recodificado. Se lee de pbi_config/equiv_articulos.
let EQUIV_ART = null;

async function cargarEquivArticulos() {
  if (EQUIV_ART) return EQUIV_ART;
  EQUIV_ART = {};
  try {
    const d = await fbLeerDocumento("pbi_config", "equiv_articulos");
    if (d && d.mapa) {
      const obj = JSON.parse(d.mapa);
      for (const [a, b] of Object.entries(obj)) {
        EQUIV_ART[String(a).toUpperCase().trim()] = String(b).toUpperCase().trim();
      }
    }
  } catch (e) { /* sin tabla se usan los codigos tal cual */ }
  return EQUIV_ART;
}

const codArt = (c) => {
  const x = String(c || "").toUpperCase().trim();
  return (EQUIV_ART && EQUIV_ART[x]) || x;
};

let RAMAS = {
  // valor de Agentes[GRUPONIVEL4] normalizado -> rama final
  WIKUK: "WIKUK",
  INTERKEY: "INTERKEY",
  PORTUGAL: "INTERKEY",     // Portugal se integro en Interkey
  FRANCIA: "FRANCIA",
  DISTRIBUIDOR: "DISTRIBUIDOR",
  // sin GRUPONIVEL4 son los comerciales de Discob
  "": "FRANCIA",
  // Agentes[GRUPONIVEL3] = Distribuidor manda sobre la division comercial
  _porTipo: { DISTRIBUIDOR: "DISTRIBUIDOR" },
};

const sinTildes = (v) => String(v || "").toUpperCase().trim()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "");

function ramaDe(equipo, tipo) {
  const t = sinTildes(tipo);
  if (RAMAS._porTipo && RAMAS._porTipo[t]) return RAMAS._porTipo[t];
  const e = sinTildes(equipo);
  if (RAMAS[e]) return RAMAS[e];
  // "Interkey Julio" y similares
  for (const k of Object.keys(RAMAS)) {
    if (k && k !== "_porTipo" && e.startsWith(k)) return RAMAS[k];
  }
  return e || RAMAS[""] || null;
}

function canonico(cod) {
  const c = String(cod || "").trim().toUpperCase();
  if (!RECOD.prefijo) return c;
  const re = new RegExp(`^${RECOD.prefijo}(\\d{${RECOD.digitos}})$`);
  const m = re.exec(c);
  return m ? RECOD.prefijo + RECOD.inserta + m[1] : c;
}

// Lee la configuracion editable. Si no existe, se sigue con los valores
// por defecto: la sincronizacion nunca debe caerse por esto.
async function cargarReglas() {
  try {
    const cfg = await fbLeerDocumento("pbi_config", "reglas");
    if (!cfg) return false;
    if (cfg.recodPrefijo !== undefined) RECOD.prefijo = String(cfg.recodPrefijo || "");
    if (cfg.recodDigitos) RECOD.digitos = Number(cfg.recodDigitos) || 4;
    if (cfg.recodInserta !== undefined) RECOD.inserta = String(cfg.recodInserta || "");

    // Ramas: campos rama_WIKUK="WIKUK", rama_PORTUGAL="INTERKEY", etc.
    const ramas = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (k.startsWith("rama_") && v) ramas[k.slice(5).toUpperCase()] = String(v);
      if (k.startsWith("tipo_") && v) {
        RAMAS._porTipo = RAMAS._porTipo || {};
        RAMAS._porTipo[k.slice(5).toUpperCase()] = String(v);
      }
    }
    if (Object.keys(ramas).length) Object.assign(RAMAS, ramas);
    if (cfg.ramaSinEquipo) RAMAS[""] = String(cfg.ramaSinEquipo);
    return true;
  } catch (e) { return false; }
}

// Normaliza el nombre comercial para poder emparejar el mismo cliente
// dado de alta con codigos distintos en varias sociedades del grupo.
// Quita acentos, formas juridicas y puntuacion.
function normNombre(n) {
  return String(n || "")
    .toUpperCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")   // acentos
    .replace(/[.,'"`&\-\/]/g, " ")
    .replace(/\b(S\s?L\s?U|S\s?L|S\s?A\s?U|S\s?A|SLNE|SCP|SCCL|CB|SC|LDA|GMBH|SRL|CO\s?KG|E\s?I)\b/g, " ")
    .replace(/\bE\s+HIJOS\b|\bY\s+HIJOS\b|\bHNOS\b|\bHERMANOS\b/g, " HNOS ")
    .replace(/\s+/g, " ")
    .trim();
}

// Borra documentos por id. Firestore admite hasta 500 operaciones por
// llamada, asi que se trocea igual que en la escritura.
async function fbBorrar(coleccion, ids) {
  if (!ids || !ids.length) return 0;
  const base = `projects/${ENV.FB_PROJECT_ID}/databases/(default)/documents`;
  const q = ENV.FB_API_KEY ? `?key=${ENV.FB_API_KEY}` : "";
  const url = `https://firestore.googleapis.com/v1/${base}:commit${q}`;
  let borrados = 0;
  for (let i = 0; i < ids.length; i += 400) {
    const lote = ids.slice(i, i + 400).map((id) => ({
      delete: `${base}/${coleccion}/${id}`,
    }));
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ writes: lote }),
    });
    if (!r.ok) throw new Error(`borrar ${coleccion}: HTTP ${r.status}`);
    borrados += lote.length;
  }
  return borrados;
}

// Limpia el código para usarlo como id de documento
const docId = (v) => String(v || "").trim().replace(/[/#?\[\]*]/g, "_") || "SIN_CODIGO";

// ─────────────── Handler ───────────────
export default async function handler(req, res) {
  // Consulta de solo lectura que llama la pantalla de análisis desde el
  // navegador. Va antes del control de acceso porque no se puede poner el
  // secreto en el código del cliente sin exponerlo. No escribe nada.
  // ?articulosCliente=CODIGO → los artículos donde ese cliente ha caído más
  // respecto al año anterior. Se consulta a demanda, no se guarda: 6.597
  // clientes por cinco artículos serían 33.000 documentos en Firestore.
  if (req.query.articulosCliente) {
    const cli = String(req.query.articulosCliente).trim().toUpperCase()
      .replace(/[^A-Z0-9._-]/g, "");
    const n = Math.min(parseInt(req.query.top, 10) || 5, 30);
    const out = { ok: true, cliente: cli, top: n };
    try {
      // Los artículos de un cliente solo cambian cuando corre la
      // sincronización. Se guarda la consulta junto al sello de la última, y
      // mientras coincidan se devuelve lo guardado sin tocar Power BI.
      let sello = null;
      try {
        const m = await fbLeerDocumento("pbi_meta", "estado");
        sello = m && m.ultimaSync ? String(m.ultimaSync) : null;
      } catch (e) { /* sin sello se consulta siempre */ }

      const idCache = docId(`${cli}_${n}`);
      if (sello && req.query.recargar !== "1") {
        try {
          const g = await fbLeerDocumento("pbi_articulos_cliente", idCache);
          if (g && g.basadoEn === sello && g.datos) {
            out.articulos = JSON.parse(g.datos);
            out.deCache = true;
            out.basadoEn = sello;
            out.codigosConsultados = g.codigos ? JSON.parse(g.codigos) : undefined;
            return res.status(200).json(out);
          }
        } catch (e) { /* si falla la lectura se consulta Power BI */ }
      }

      await cargarEquivArticulos();
      const { token } = await getToken(req);
      const T = M.ventas;
      const Q = dax(null);   // se necesita el maestro de articulos

      // El historico de ventas conserva el codigo antiguo del cliente, asi que
      // hay que consultar tambien su variante: U4309094 hoy era U439094 antes
      // de la recodificacion de marzo. Sin esto el ano anterior sale a cero.
      const variantes = new Set([cli]);
      const m = /^U430(\d{4})$/.exec(cli);
      if (m) variantes.add("U43" + m[1]);
      const canon = canonico(cli);
      if (canon !== cli) variantes.add(canon);
      const enLista = [...variantes].map((c) => `"${c}"`).join(", ");
      out.codigosConsultados = [...variantes];

      // Los filtros van como condiciones simples de columna, no con FILTER
      // sobre toda la tabla: FILTER sustituye el contexto y devolvia el total
      // del cliente en todas las filas en vez del importe de cada articulo.
      const filas = await pbiQuery(token, `
DEFINE
  VAR _hoy = TODAY()
  VAR _anoAct = YEAR(_hoy)
  VAR _anoAnt = _anoAct - 1
  VAR _iniAct = DATE(_anoAct, 1, 1)
  VAR _iniAnt = DATE(_anoAnt, 1, 1)
  VAR _corteAnt = DATE(_anoAnt, MONTH(_hoy), DAY(_hoy))
EVALUATE
  TOPN(${Math.min(n * 10, 80)},
    FILTER(
      ADDCOLUMNS(
        CALCULATETABLE(VALUES(${T}[CODIGO]), ${T}[CLIENTE] IN {${enLista}}),
        "Act", CALCULATE(SUM(${M.vBase}),
          ${T}[CLIENTE] IN {${enLista}},
          ${M.vFecha} >= _iniAct, ${M.vFecha} <= _hoy),
        "Ant", CALCULATE(SUM(${M.vBase}),
          ${T}[CLIENTE] IN {${enLista}},
          ${M.vFecha} >= _iniAnt, ${M.vFecha} <= _corteAnt),
        "UniAct", CALCULATE(SUM(${T}[UNI]),
          ${T}[CLIENTE] IN {${enLista}},
          ${M.vFecha} >= _iniAct, ${M.vFecha} <= _hoy)
      ),
      [Ant] <> 0 || [Act] <> 0
    ),
    [Ant] - [Act], DESC)`, true);

      // Descripción del maestro de artículos
      const arts = new Map();
      try {
        for (const a of await pbiQuery(token, Q.articulos, true)) {
          const cod = String(pick(a, "CODIGO") || "").trim();
          if (cod && !arts.has(cod)) arts.set(cod, {
            descripcion: pick(a, "DESCRIPCION"),
            calibre: pick(a, "CALIBRE"),
            metros: pick(a, "METROS"),
          });
        }
      } catch (e) { out.errorMaestro = e.message.slice(0, 160); }
      out.articulosEnMaestro = arts.size;

      // TOPN recorta por caida pero no garantiza el orden de salida: se
      // reordena aqui para que el que mas cae salga primero.
      // Se agrupa por el codigo actual: la venta del codigo antiguo se suma a
      // la del nuevo, y el falso -100% desaparece. Por eso se piden mas filas
      // a Power BI de las que se devuelven: el recorte va despues de traducir.
      const porCodigo = new Map();
      let traducidos = 0;
      for (const r of filas) {
        const original = String(pick(r, "CODIGO") || "").trim().toUpperCase();
        if (!original) continue;
        const cod = codArt(original);
        if (cod !== original) traducidos++;

        const g = porCodigo.get(cod) || {
          articulo: cod, ventasAct: 0, ventasAnt: 0, unidades: 0, codigosOrigen: [],
        };
        g.ventasAct += num(pick(r, "Act"));
        g.ventasAnt += num(pick(r, "Ant"));
        g.unidades  += num(pick(r, "UniAct"));
        if (!g.codigosOrigen.includes(original)) g.codigosOrigen.push(original);
        porCodigo.set(cod, g);
      }
      out.codigosTraducidos = traducidos;

      out.articulos = [...porCodigo.values()].map((g) => {
        // La descripcion se busca por el codigo actual y, si no esta en el
        // maestro, por cualquiera de los antiguos que lo alimentan.
        let f = arts.get(g.articulo);
        if (!f) for (const o of g.codigosOrigen) { if (arts.get(o)) { f = arts.get(o); break; } }
        f = f || {};
        const act = num(g.ventasAct);
        const ant = num(g.ventasAnt);
        return {
          articulo: g.articulo,
          descripcion: f.descripcion || null,
          calibre: f.calibre || null,
          metros: f.metros || null,
          ventasAct: act,
          ventasAnt: ant,
          diferencia: num(act - ant),
          variacionPct: ant ? num((100 * (act - ant)) / ant) : null,
          unidades: num(g.unidades),
          // Solo se informa si hubo recodificacion, para poder auditarlo
          codigoAntiguo: g.codigosOrigen.filter((o) => o !== g.articulo).join(", ") || undefined,
        };
      })
        .filter((a) => a.ventasAct !== 0 || a.ventasAnt !== 0)
        .sort((a, b) => a.diferencia - b.diferencia)
        .slice(0, n);
      out.deCache = false;
      out.basadoEn = sello;

      // Se guarda para las siguientes consultas del mismo cliente
      if (sello) {
        try {
          await fbCommit("pbi_articulos_cliente", [{
            _id: idCache,
            cliente: cli,
            basadoEn: sello,
            datos: JSON.stringify(out.articulos),
            codigos: JSON.stringify(out.codigosConsultados || []),
            guardadoEl: new Date().toISOString(),
          }]);
        } catch (e) { out.avisoCache = e.message.slice(0, 120); }
      }
    } catch (e) {
      out.ok = false;
      out.error = e.message;
    }
    return res.status(200).json(out);
  }

  // ?limpiarArticulos=1 → borra las consultas de artículos guardadas, para que
  // se recalculen con la tabla de equivalencias actual. Alternativa rápida a
  // relanzar la sincronización completa, que también las invalida al cambiar
  // el sello pero tarda casi un minuto.
  if (req.query.limpiarArticulos === "1") {
    const out = { ok: true };
    try {
      const guardadas = await fbLeerColeccion("pbi_articulos_cliente");
      out.encontradas = guardadas.length;
      const ids = guardadas.map((d) => d._id);
      if (ids.length) {
        for (let i = 0; i < ids.length; i += 400) {
          await fbBorrar("pbi_articulos_cliente", ids.slice(i, i + 400));
        }
      }
      out.borradas = ids.length;
      out.nota = "Las próximas consultas volverán a Power BI y aplicarán las equivalencias.";
    } catch (e) {
      out.ok = false;
      out.error = e.message;
    }
    return res.status(200).json(out);
  }

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
  // ?tablas=1 → lista las tablas del modelo y, si se pide, busca una columna
  // concreta en todas ellas. Util cuando el ERP tiene un campo que no se sabe
  // si ha llegado al modelo, como VALIDARPRECIO.
  if (req.query.tablas === "1") {
    const out = { ok: true };
    try {
      const { token } = await getToken(req);
      const filas = await pbiQuery(token,
        `EVALUATE SELECTCOLUMNS(INFO.TABLES(), "Tabla", [Name])`, true);
      out.tablas = filas.map((r) => pick(r, "Tabla")).filter(Boolean).sort();
      out.total = out.tablas.length;

      // &buscar=VALIDAR → devuelve en que tablas aparece esa columna
      if (req.query.buscar) {
        const q = String(req.query.buscar).toUpperCase();
        const cols = await pbiQuery(token, `
EVALUATE
  SELECTCOLUMNS(
    NATURALLEFTOUTERJOIN(
      SELECTCOLUMNS(INFO.COLUMNS(), "TableID", [TableID], "Columna", [ExplicitName]),
      SELECTCOLUMNS(INFO.TABLES(), "TableID", [ID], "Tabla", [Name])
    ),
    "Tabla", [Tabla], "Columna", [Columna])`, true);
        out.coincidencias = cols
          .filter((c) => String(pick(c, "Columna") || "").toUpperCase().includes(q))
          .map((c) => `${pick(c, "Tabla")} → ${pick(c, "Columna")}`);
      }
    } catch (e) {
      out.ok = false;
      out.error = e.message;
    }
    return res.status(200).json(out);
  }

  if (req.query.peek === "1") {
    const out = { ok: true };
    try {
      const { token, modo } = await getToken(req);
      out.modoAuth = modo;
      // ?peek=1&tabla=06 Clientes United SAP  → inspecciona cualquier tabla
      // del modelo, no solo las cuatro habituales.
      if (req.query.tabla) {
        const t = `'${String(req.query.tabla).replace(/'/g, "")}'`;
        // &filas=N para traer mas de 3, y &col=X&val=Y para filtrar
        const n = Math.min(parseInt(req.query.filas, 10) || 3, 500);
        const cf = req.query.col
          ? `FILTER(${t}, NOT ISBLANK(${t}[${String(req.query.col).replace(/[\[\]"]/g, "")}]))`
          : t;
        try {
          const filas = await pbiQuery(token, `EVALUATE TOPN(${n}, ${cf})`, true);
          out.tablaSolicitada = {
            tabla: t,
            filas: filas.length,
            datos: filas,
            columnas: Object.keys(filas[0] || {}).map((c) => ({
              nombre: c,
              ejemplos: filas.map((f) => f[c]),
            })),
          };
        } catch (e) {
          out.tablaSolicitada = { tabla: t, error: e.message.slice(0, 300) };
        }
        return res.status(200).json(out);
      }

      const tablas = {
        ventas:    M.ventas,
        pendiente: M.pendiente,
        stock:     M.stock,
        clientes:  M.clientes,
      };
      // ?peek=1&codigos=C03509,U433509 → ficha completa de esos clientes
      // en la tabla de clientes, con TODAS las columnas incluidas las
      // vacias. Sirve para buscar un campo que enlace codigo viejo y nuevo.
      if (req.query.codigos) {
        const lista = String(req.query.codigos)
          .split(",").map((c) => c.trim().replace(/"/g, "")).filter(Boolean);
        try {
          out.fichasCliente = await pbiQuery(token, `
EVALUATE
  FILTER(${M.clientes}, ${M.clientes}[CODIGO] IN {${lista.map((c) => `"${c}"`).join(", ")}})`,
            true);
        } catch (e) {
          out.fichasCliente = { error: e.message.slice(0, 250) };
        }
      }

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

      // C 0) Lineas crudas de una familia de articulos, con TODAS las
      // columnas de coste una al lado de otra. Sirve para decidir si
      // COSTOLINEAL es el coste bueno en los productos por metros.
      //   ?audit=1&articulo=MX255
      const pref = String(req.query.articulo || "MX255").replace(/"/g, "");
      out.familiaAnalizada = pref;
      out.lineasFamilia = await pbiQuery(token, `
EVALUATE
  TOPN(
    15,
    SELECTCOLUMNS(
      FILTER(${T}, LEFT(${T}[CODIGO], ${pref.length}) = "${pref}"),
      "Articulo",      ${T}[CODIGO],
      "Fecha",         ${T}[FECHA],
      "Uni",           ${T}[UNI],
      "Metros",        ${T}[METROS],
      "MetrosTotales", ${T}[Metros Totales],
      "Calibre",       ${T}[CALIBRE],
      "Precio",        ${T}[PRECIO],
      "Base",          ${M.vBase},
      "CosteRefUnit",  ${T}[COSTOREFERENCIA],
      "CosteRefLinea", ${M.vCoste},
      "CosteLineal",   ${T}[COSTOLINEAL]
    ),
    [Fecha], DESC
  )`, true);

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

      // C quater) Rango temporal real de la tabla de hechos.
      // Necesario para saber sobre que periodo se esta calculando todo.
      out.porAno = await pbiQuery(token, `
EVALUATE
  SUMMARIZECOLUMNS(
    ${T}[ANO],
    "Venta",  SUM(${M.vBase}),
    "Lineas", COUNTROWS(${T}),
    "Desde",  MIN(${M.vFecha}),
    "Hasta",  MAX(${M.vFecha})
  )
  ORDER BY ${T}[ANO]`);

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

  // ?ver=RPIEDRA → ficha de ventas de un comercial, leida de Firestore.
  // No toca Power BI: consulta lo ya sincronizado, asi que es instantanea.
  if (req.query.ver) {
    const id = String(req.query.ver).trim().toUpperCase();
    try {
      const base = `projects/${ENV.FB_PROJECT_ID}/databases/(default)/documents`;
      const key = ENV.FB_API_KEY ? `?key=${ENV.FB_API_KEY}` : "";

      const resumen = await fbLeerDocumento("pbi_resumen_agente", docId(id));

      // Sin orderBy para no exigir indice compuesto en Firestore:
      // se ordena despues en JavaScript.
      const r = await fetch(`https://firestore.googleapis.com/v1/${base}:runQuery${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: "pbi_ventas_cliente" }],
            where: { fieldFilter: {
              field: { fieldPath: "agente" },
              op: "EQUAL",
              value: { stringValue: id },
            }},
            limit: 500,
          },
        }),
      });
      const filas = await r.json();
      const clientes = (Array.isArray(filas) ? filas : [])
        .filter((f) => f.document)
        .map((f) => {
          const o = { _id: f.document.name.split("/").pop() };
          for (const [k, v] of Object.entries(f.document.fields || {})) {
            o[k] = v.doubleValue !== undefined ? Number(v.doubleValue)
                 : v.integerValue !== undefined ? Number(v.integerValue)
                 : v.stringValue ?? v.booleanValue ?? null;
          }
          return o;
        })
        .filter((c) => !c.fusionadoEn)
        .sort((a, b) => (b.ventasAct || 0) - (a.ventasAct || 0));

      const eur = (n) => Number(n || 0).toLocaleString("es-ES",
        { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

      return res.status(200).json({
        ok: true,
        agente: id,
        resumen: resumen ? {
          ventas2025completo: eur(resumen.ventasAntFull),
          ventas2025mismoPeriodo: eur(resumen.ventasAntYTD),
          ventas2026: eur(resumen.ventasAct),
          variacion: resumen.variacionPct !== null ? `${resumen.variacionPct} %` : "—",
          margen2026: resumen.margenPctAct !== null ? `${resumen.margenPctAct} %` : "—",
          margen2025: resumen.margenPctAntYTD !== null ? `${resumen.margenPctAntYTD} %` : "—",
          margenMes: resumen.margenPctMes != null ? `${resumen.margenPctMes} %` : "FALTA",
          margenMesAnt: resumen.margenPctMesAnt != null ? `${resumen.margenPctMesAnt} %` : "FALTA",
          coberturaAntYTD: resumen.coberturaAntYTD != null ? `${resumen.coberturaAntYTD} %` : "FALTA",
          ventasMesAnt: resumen.ventasMesAnt != null ? eur(resumen.ventasMesAnt) : "FALTA",
          baseMesAnt:   resumen.baseMesAnt != null ? eur(resumen.baseMesAnt) : "FALTA",
          ventasMesActual: eur(resumen.ventasMes),
          clientes: resumen.clientes,
          clientesConVentaEsteMes: resumen.clientesConVentaMes,
          coberturaMargen: `${resumen.coberturaAct} %`,
        } : "sin datos: lanza primero una sincronizacion real",
        totalClientes: clientes.length,
        top20: clientes.slice(0, 20).map((c) => ({
          codigo: c.cliente,
          nombre: c.nombre,
          poblacion: c.poblacion,
          v2026: eur(c.ventasAct),
          // Las dos cifras de 2025: la comparable y la del ano cerrado.
          // La variacion se calcula SIEMPRE contra el mismo periodo.
          v2025mismoPeriodo: eur(c.ventasAntYTD),
          v2025completo: eur(c.ventasAntFull),
          variacion: c.variacionPct !== null && c.variacionPct !== undefined
            ? `${c.variacionPct} %` : "sin venta en ese periodo",
          margen: c.margenPctAct !== null && c.margenPctAct !== undefined
            ? `${c.margenPctAct} %` : "—",
          ultimaVenta: (c.ultimaVenta || "").slice(0, 10),
        })),
        sinVentaEsteAno: clientes.filter((c) => !c.ventasAct).length,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ?vendedores=1 → ventas del mes agrupadas por el VENDEDOR del ERP,
  // que es el mismo campo que usa el Panel Principal de Power BI.
  // Sirve para comparar cifra a cifra y localizar diferencias, sin que
  // interfiera el mapeo a los agentes del CRM.
  if (req.query.vendedores === "1") {
    try {
      const { token } = await getToken(req);
      const T = M.ventas;
      const filas = await pbiQuery(token, `
DEFINE
  VAR _hoy = TODAY()
  VAR _iniMes = DATE(YEAR(_hoy), MONTH(_hoy), 1)
  VAR _anoAct = YEAR(_hoy)
EVALUATE
  SUMMARIZECOLUMNS(
    ${T}[VENDEDOR],
    "VentasMes", CALCULATE(SUM(${M.vBase}), ${M.vFecha} >= _iniMes && ${M.vFecha} <= _hoy),
    "VentasAno", CALCULATE(SUM(${M.vBase}), FILTER(${T}, YEAR(${M.vFecha}) = _anoAct))
  )
  ORDER BY [VentasMes] DESC`);

      const eur = (n) => Number(n || 0).toLocaleString("es-ES",
        { maximumFractionDigits: 0 });
      const lista = filas.map((r) => ({
        vendedor: pick(r, "VENDEDOR"),
        ventasMes: num(pick(r, "VentasMes")),
        ventasAno: num(pick(r, "VentasAno")),
      })).filter((v) => v.ventasMes || v.ventasAno);

      return res.status(200).json({
        ok: true,
        nota: "Mismo campo VENDEDOR que el Panel Principal. Incluye intercompania.",
        desde: `01/${String(new Date().getMonth() + 1).padStart(2, "0")}`,
        hasta: new Date().toISOString().slice(0, 10),
        totalMes: eur(lista.reduce((t, v) => t + v.ventasMes, 0)),
        totalAno: eur(lista.reduce((t, v) => t + v.ventasAno, 0)),
        vendedores: lista.map((v) => ({
          vendedor: v.vendedor,
          ventasMes: eur(v.ventasMes),
          ventasAno: eur(v.ventasAno),
        })),
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ?pedidos=1 → radiografia de "00 Entrada Pedidos Global".
  // Antes de construir nada encima hay que saber si tiene importes de
  // verdad, que periodo cubre y si el pendiente se puede aislar.
  if (req.query.pedidos === "1") {
    const T = "'00 Entrada Pedidos Global'";
    const V = "'00 Pedidos Validados Global'";
    const out = { ok: true, entrada: T, validados: V };
    let token;
    try { ({ token } = await getToken(req)); }
    catch (e) { return res.status(500).json({ ok: false, error: e.message }); }

    // Cada consulta va aislada: si una falla, las demas siguen. Antes un
    // error de DAX en el primer bloque dejaba la respuesta a medias.
    const pedir = async (clave, dax) => {
      try { out[clave] = await pbiQuery(token, dax, true); }
      catch (e) { out[clave] = { error: e.message.slice(0, 240) }; }
    };

    await pedir("totalesEntrada", `
EVALUATE
  ROW(
    "Lineas",        COUNTROWS(${T}),
    "Importe",       SUM(${T}[BASE]),
    "LineasConImporte", CALCULATE(COUNTROWS(${T}), FILTER(${T}, ${T}[BASE] > 0)),
    "Clientes",      DISTINCTCOUNT(${T}[CLIENTE]),
    "Articulos",     DISTINCTCOUNT(${T}[CODIGO]),
    "Familias",      DISTINCTCOUNT(${T}[FAMILIA]),
    "PrimerPedido",  MIN(${T}[FECHA]),
    "UltimoPedido",  MAX(${T}[FECHA]),
    "UltimaEntrega", MAX(${T}[FECHAPLANIFICADA])
  )`);

    await pedir("porAnoEntrada", `
EVALUATE
  GROUPBY(
    ADDCOLUMNS(${T}, "@Ano", YEAR(${T}[FECHA])),
    [@Ano],
    "Lineas",  SUMX(CURRENTGROUP(), 1),
    "Importe", SUMX(CURRENTGROUP(), ${T}[BASE])
  )
  ORDER BY [@Ano] DESC`);

    await pedir("esVisita", `
EVALUATE
  SUMMARIZECOLUMNS(
    ${T}[ESVISITA],
    "Lineas", COUNTROWS(${T}),
    "Importe", SUM(${T}[BASE])
  )`);

    // El Panel Principal muestra "Ped. Pdte de Servir". Si el total de
    // validados coincide con esa cifra, validado equivale a pendiente y no
    // hace falta ningun campo de estado.
    await pedir("totalesValidados", `
DEFINE
  VAR _hoy = TODAY()
EVALUATE
  ROW(
    "Lineas",         COUNTROWS(${V}),
    "Importe",        SUM(${V}[BASE]),
    "Unidades",       SUM(${V}[UNI]),
    "Pedidos",        DISTINCTCOUNT(${V}[NumPedido]),
    "Clientes",       DISTINCTCOUNT(${V}[CLIENTE]),
    "PrimeraEntrega", MIN(${V}[FECHAPLANIFICADA]),
    "UltimaEntrega",  MAX(${V}[FECHAPLANIFICADA]),
    "EntregaFutura",  CALCULATE(SUM(${V}[BASE]), FILTER(${V}, ${V}[FECHAPLANIFICADA] >= _hoy)),
    "EntregaPasada",  CALCULATE(SUM(${V}[BASE]), FILTER(${V}, ${V}[FECHAPLANIFICADA] < _hoy))
  )`);

    await pedir("validadosPorCliente", `
EVALUATE
  TOPN(10,
    SUMMARIZECOLUMNS(
      ${V}[CLIENTE],
      ${V}[VENDEDOR],
      "Importe", SUM(${V}[BASE]),
      "Lineas",  COUNTROWS(${V})
    ),
    [Importe], DESC)`);

    await pedir("topFamilias", `
EVALUATE
  TOPN(10,
    SUMMARIZECOLUMNS(
      ${T}[FAMILIA],
      "Lineas", COUNTROWS(${T}),
      "Importe", SUM(${T}[BASE])
    ),
    [Importe], DESC)`);

    return res.status(200).json(out);
  }

  // ?solopedidos=1 → sincroniza unicamente los pedidos planificados.
  // La sincronizacion completa consume casi los 60 s de Vercel con las
  // ventas y nunca llega a este bloque, asi que se puede lanzar aparte.
  if (req.query.solopedidos === "1") {
    const t1 = Date.now();
    const out = { ok: true };
    try {
      const { token, modo } = await getToken(req);
      out.modoAuth = modo;
      const Q = dax(null);

      // Ficha de cliente para poner nombre y poblacion
      const fichas = new Map();
      for (const c of await pbiQuery(token, Q.clientes)) {
        const cod = String(pick(c, "CODIGO") || "").trim();
        if (!cod || fichas.has(cod)) continue;
        fichas.set(cod, {
          nombre: pick(c, "NOMBRE"),
          poblacion: pick(c, "POBLACION"),
        });
      }

      // Vendedor -> comercial del CRM
      const agentes = new Map();
      for (const a of await pbiQuery(token, Q.agentes, true)) {
        const cod = String(pick(a, "CODIGO") || "").trim();
        if (cod) agentes.set(cod, String(pick(a, "GRUPOAGENTE") || "").trim() || null);
      }

      // Maestro de articulos, para poner descripcion en cada linea
      const arts = new Map();
      try {
        for (const a of await pbiQuery(token, Q.articulos, true)) {
          const cod = String(pick(a, "CODIGO") || "").trim();
          if (!cod || arts.has(cod)) continue;
          arts.set(cod, {
            descripcion: pick(a, "DESCRIPCION"),
            metros: pick(a, "METROS"),
            calibre: pick(a, "CALIBRE"),
            calidad: pick(a, "CALIDAD"),
          });
        }
      } catch (e) { /* sin maestro se muestra solo el codigo */ }

      const filas = await pbiQuery(token, Q.pedidos);
      const docs = filas.map((r, i) => {
        const cli = String(pick(r, "Cliente") || "").trim();
        const ven = String(pick(r, "Vendedor") || "").trim();
        const fec = String(pick(r, "Fecha") || "").slice(0, 10);
        const art = String(pick(r, "Articulo") || "").trim();
        const ficha = fichas.get(cli) || fichas.get(canonico(cli)) || {};
        return {
          _id: docId(`${fec}_${cli}_${art}_${i}`),
          cliente: cli,
          nombre: ficha.nombre || cli,
          poblacion: ficha.poblacion || null,
          agente: agentes.get(ven) || null,
          vendedor: ven,
          fecha: fec,
          articulo: art,
          familia: String(pick(r, "Familia") || "").trim() || null,
          unidades: num(pick(r, "Uni")),
          precio: num(pick(r, "Precio")),
          descripcion: (arts.get(art) || {}).descripcion || null,
          metros: (arts.get(art) || {}).metros || null,
          calibre: (arts.get(art) || {}).calibre || null,
          calidad: (arts.get(art) || {}).calidad || null,
          subfamilia: String(pick(r, "Subfamilia") || "").trim() || null,
          importe: num(pick(r, "Importe")),
          pedido: String(pick(r, "Pedido") || "").trim(),
          // Traspasos entre empresas del grupo: mismo criterio que en ventas
          intercompany: esIntercompany(ficha.nombre || cli),
          actualizado: new Date().toISOString(),
        };
      }).filter((d) => d.cliente && d.fecha);

      out.lineas = docs.length;
      out.importe = num(docs.reduce((t, d) => t + d.importe, 0));
      out.clientes = new Set(docs.map((d) => d.cliente)).size;
      out.sinAgente = docs.filter((d) => !d.agente).length;
      out.intercompany = docs.filter((d) => d.intercompany).length;
      out.importeIntercompany = num(docs.filter((d) => d.intercompany)
        .reduce((t, d) => t + d.importe, 0));
      out.conDescripcion = docs.filter((d) => d.descripcion).length;
      out.pedidosDistintos = new Set(docs.map((d) => d.pedido).filter(Boolean)).size;
      out.primeraEntrega = docs.map((d) => d.fecha).sort()[0] || null;

      // ── Resumen por comercial: entrada de pedidos y previsión ──
      // Dos cosas distintas y complementarias:
      //   entrada*   = pedidos METIDOS en el periodo (trabajo de la semana)
      //   previsto*  = pedidos que SALEN en el periodo (lo que se facturara)
      const porAg = {};
      const dameAg = (a) => (porAg[a] = porAg[a] || {
        _id: docId(a), agente: a,
        entradaSem: 0, entradaMes: 0, entradaAno: 0,
        entradaSemAnt: 0, entradaAnoAnt: 0,
        previstoEstaSem: 0, previstoProxSem: 0, previstoTotal: 0,
      });

      try {
        for (const e of await pbiQuery(token, Q.entrada)) {
          const ven = String(pick(e, "VENDEDOR") || "").trim();
          const ag = agentes.get(ven);
          if (!ag) continue;
          const a = dameAg(ag);
          a.entradaSem    += num(pick(e, "Sem"));
          a.entradaMes    += num(pick(e, "Mes"));
          a.entradaAno    += num(pick(e, "Ano"));
          a.entradaSemAnt += num(pick(e, "SemAnt"));
          a.entradaAnoAnt += num(pick(e, "AnoAnt"));
        }
      } catch (e) { out.errorEntrada = e.message.slice(0, 200); }

      // Lo que sale esta semana y la que viene, a partir de los pedidos ya
      // planificados: permite anticipar si se llegara al objetivo.
      const hoy0 = new Date(); hoy0.setHours(0, 0, 0, 0);
      const lunes = new Date(hoy0);
      lunes.setDate(lunes.getDate() - ((lunes.getDay() + 6) % 7));
      const finSem = new Date(lunes); finSem.setDate(finSem.getDate() + 6);
      const finProx = new Date(lunes); finProx.setDate(finProx.getDate() + 13);
      const iso = (d) => d.toISOString().slice(0, 10);

      for (const d of docs) {
        if (!d.agente || d.intercompany) continue;
        const a = dameAg(d.agente);
        a.previstoTotal += d.importe;
        if (d.fecha <= iso(finSem)) a.previstoEstaSem += d.importe;
        else if (d.fecha <= iso(finProx)) a.previstoProxSem += d.importe;
      }

      const resumen = Object.values(porAg).map((a) => ({
        ...a,
        entradaSem: num(a.entradaSem), entradaMes: num(a.entradaMes),
        entradaAno: num(a.entradaAno), entradaSemAnt: num(a.entradaSemAnt),
        entradaAnoAnt: num(a.entradaAnoAnt),
        previstoEstaSem: num(a.previstoEstaSem),
        previstoProxSem: num(a.previstoProxSem),
        previstoTotal: num(a.previstoTotal),
        actualizado: new Date().toISOString(),
      }));

      if (req.query.dry === "1") {
        out.dry = true;
        out.muestra = docs.slice(0, 5);
        out.resumenAgentes = resumen.slice(0, 8);
      } else {
        out.escritos = await fbCommit("pbi_pedidos", docs);
        out.agentesConEntrada = await fbCommit("pbi_entrada_agente", resumen);
        // Fuera lo ya servido
        const hoyISO = new Date().toISOString().slice(0, 10);
        const guardados = await fbLeerColeccion("pbi_pedidos");
        const caducados = guardados
          .filter((g) => !g.fecha || String(g.fecha) < hoyISO)
          .map((g) => g._id);
        out.caducadosBorrados = caducados.length;
        if (caducados.length) await fbBorrar("pbi_pedidos", caducados);
      }
      out.segundos = Math.round((Date.now() - t1) / 1000);
    } catch (e) {
      out.ok = false;
      out.error = e.message;
    }
    return res.status(out.ok ? 200 : 500).json(out);
  }

  const dry = req.query.dry === "1"; // ?dry=1 → consulta pero NO escribe
  const t0 = Date.now();
  const log = { dry, ventas: 0, pendiente: 0, stock: 0, errores: [] };

  try {
    const { token, modo } = await getToken(req);
    log.modoAuth = modo;

    log.reglasDeFirestore = await cargarReglas();

    // Correcciones de rama hechas a mano en la herramienta de estructura.
    // Mandan sobre la regla general y se resuelven aqui, no en cada pagina.
    const AJUSTES_RAMA = {};
    try {
      for (const a of await fbLeerColeccion("pbi_ajustes")) {
        if (a.equipo && a.equipo !== "_EXCLUIR")
          AJUSTES_RAMA[String(a._id).toUpperCase()] = a.equipo;
      }
    } catch (e) {
      log.errores.push(`ajustes de rama: ${e.message}`);
    }
    log.ajustesRama = Object.keys(AJUSTES_RAMA).length;
    globalThis.__AJUSTES_RAMA__ = AJUSTES_RAMA;

    // ── Decidir si toca sincronizacion completa o incremental ──
    // Se fuerza completa cuando:
    //   - se pide con ?full=1
    //   - no hay sincronizacion previa registrada
    //   - es dia 1 de mes (cambian los acumulados del mes)
    //   - han pasado mas de 7 dias (por si fallo el cron algun dia)
    //   - estamos en enero (cambio de ejercicio: se recalcula todo)
    let desde = null;
    if (req.query.full !== "1") {
      try {
        const meta = await fbLeerDocumento("pbi_meta", "estado");
        const ultima = meta?.ultimaSync ? new Date(meta.ultimaSync) : null;
        const hoy = new Date();
        const dias = ultima ? (hoy - ultima) / 86400000 : 999;
        const forzar = !ultima || dias > 7 || hoy.getDate() === 1 || hoy.getMonth() === 0;
        if (!forzar) {
          // Margen de 3 dias hacia atras: recoge facturas grabadas con
          // retraso o rectificaciones sobre dias ya sincronizados.
          desde = new Date(ultima.getTime() - 3 * 86400000);
        }
      } catch (e) {
        log.avisoIncremental = `sin metadatos previos, se hace completa (${e.message})`;
      }
    }
    log.tipoSync = desde ? "incremental" : "completa";
    if (desde) log.desde = desde.toISOString().slice(0, 10);

    const Q = dax(desde);

    // ── 1. Ventas y margen por cliente ──
    try {
      const anoAct = new Date().getFullYear();
      const anoAnt = anoAct - 1;
      log.ejercicios = { actual: anoAct, anterior: anoAnt };

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

      // Mapa vendedor -> comercial, desde el propio modelo
      const agentes = new Map();
      try {
        for (const a of await pbiQuery(token, Q.agentes, true)) {
          const cod = String(pick(a, "CODIGO") || "").trim();
          if (!cod) continue;
          agentes.set(cod, {
            grupo: String(pick(a, "GRUPOAGENTE") || "").trim() || null,
            nivel1: String(pick(a, "GRUPONIVEL1") || "").trim() || null,
            ambito: String(pick(a, "GRUPONIVEL2") || "").trim() || null,
            tipo: String(pick(a, "GRUPONIVEL3") || "").trim() || null,
            // GRUPONIVEL4 es el "Grupo Agentes" del Panel Principal:
            // Wikuk, Interkey, Portugal. Es la division real del negocio.
            equipo: (() => {
              const v = String(pick(a, "GRUPONIVEL4") || "").trim();
              if (!v || v === "-") return null;
              // "Interkey Julio" parece un apaño puntual; se normaliza
              return v.startsWith("Interkey") ? "Interkey" : v;
            })(),
            // MB es el objetivo de margen (0,26 = 26%). El campo
            // "MARGEN OBJETIVO" esta casi vacio; el bueno es este.
            objetivoMargen: pick(a, "MB") ? num(100 * Number(pick(a, "MB"))) : null,
          });
        }
        log.agentesMapeados = agentes.size;
      } catch (e) {
        log.errores.push(`agentes: ${e.message}`);
      }

      // Ficha de cliente: primera aparicion de cada codigo
      const fichas = new Map();
      try {
        for (const c of await pbiQuery(token, Q.clientes)) {
          const cod = String(pick(c, "CODIGO") || "").trim();
          if (!cod || fichas.has(cod)) continue;
          fichas.set(cod, {
            nombre: pick(c, "NOMBRE"),
            poblacion: pick(c, "POBLACION"),
            provincia: pick(c, "PROVINCIA"),
            bloqueado: pick(c, "BLQ") === "SI",
            codconta: String(pick(c, "CODCONTA") || "").trim() || null,
          });
        }
        log.fichasCliente = fichas.size;
      } catch (e) {
        log.errores.push(`clientes: ${e.message}`);
      }

      const docs = filas.map((r) => {
        const cliente = pick(r, "CLIENTE");
        // Si el codigo ya no existe en el maestro, se busca su equivalente
        // recodificado para no dejar el cliente sin nombre ni poblacion.
        const ficha = fichas.get(String(cliente).trim())
          || fichas.get(canonico(cliente))
          || {};

        const vAntFull = num(pick(r, "VentaAntFull"));
        const vAntYTD  = num(pick(r, "VentaAntYTD"));
        const vAct     = num(pick(r, "VentaAct"));
        const vMes     = num(pick(r, "VentaMes"));
        const vSem     = num(pick(r, "VentaSem"));
        const vMesAnt  = num(pick(r, "VentaMesAnt"));
        const vSemAnt  = num(pick(r, "VentaSemAnt"));

        // Bases limpias (lineas con coste creible) para cada ventana
        const bAntFull = num(pick(r, "VentaAntFullOk"));
        const bAntYTD  = num(pick(r, "VentaAntYTDOk"));
        const bAct     = num(pick(r, "VentaActOk"));
        const mAntFull = num(bAntFull - num(pick(r, "CosteAntFullOk")));
        const mAntYTD  = num(bAntYTD  - num(pick(r, "CosteAntYTDOk")));
        const mAct     = num(bAct     - num(pick(r, "CosteActOk")));
        const bSem     = num(pick(r, "VentaSemOk"));
        const mSem     = num(bSem - num(pick(r, "CosteSemOk")));
        const bMes     = num(pick(r, "VentaMesOk"));
        const bMesAnt  = num(pick(r, "VentaMesAntOk"));
        const mMes     = num(bMes    - num(pick(r, "CosteMesOk")));
        const mMesAnt  = num(bMesAnt - num(pick(r, "CosteMesAntOk")));

        const p = (m, b) => (b ? num((100 * m) / b) : null);
        const cob = (b, v) => (v ? num((100 * b) / v) : 0);

        return {
          _id: docId(cliente),
          cliente,
          nombre: ficha.nombre || cliente,
          // Sin ficha = codigo que ya no existe en el maestro: historico
          // que quedo huerfano tras la recodificacion de 2026.
          huerfano: !ficha.nombre,
          // Intercompania segun GRUPONIVEL1 del modelo, que es el filtro
          // oficial del Panel Principal. El nombre queda de respaldo.
          intercompany: (agentes.get(String(pick(r, "VENDEDOR") || "").trim())?.nivel1
                          === "Intercompany") || esIntercompany(ficha.nombre),
          agente: agentes.get(String(pick(r, "VENDEDOR") || "").trim())?.grupo || null,
          tipoAgente: agentes.get(String(pick(r, "VENDEDOR") || "").trim())?.tipo || null,
          ambitoAgente: agentes.get(String(pick(r, "VENDEDOR") || "").trim())?.ambito || null,
          equipoAgente: agentes.get(String(pick(r, "VENDEDOR") || "").trim())?.equipo || null,
          objetivoMargen: agentes.get(String(pick(r, "VENDEDOR") || "").trim())?.objetivoMargen ?? null,
          poblacion: ficha.poblacion,
          provincia: ficha.provincia,
          bloqueado: ficha.bloqueado === true,
          codconta: ficha.codconta || null,
          vendedor: pick(r, "VENDEDOR"),
          empresa: pick(r, "EMPRESA"),

          anoAnterior: anoAnt,
          anoActual: anoAct,

          // Referencia: ano anterior cerrado
          ventasAntFull: vAntFull,
          margenAntFull: mAntFull,
          margenPctAntFull: p(mAntFull, bAntFull),

          // Comparativa homogenea: mismo periodo de ambos anos
          ventasAntYTD: vAntYTD,
          margenAntYTD: mAntYTD,
          margenPctAntYTD: p(mAntYTD, bAntYTD),

          ventasAct: vAct,
          margenAct: mAct,
          margenPctAct: p(mAct, bAct),

          ventasMes: vMes,
          ventasSem: vSem,
          ventasMesAnt: vMesAnt,
          ventasSemAnt: vSemAnt,

          // Margen de la semana, para el cierre semanal
          margenSem: mSem,       baseSem: bSem,
          margenPctSem: p(mSem, bSem),

          // Margen del mes, con su referencia del ano anterior
          margenMes: mMes,       baseMes: bMes,
          margenPctMes: p(mMes, bMes),
          margenMesAnt: mMesAnt, baseMesAnt: bMesAnt,
          margenPctMesAnt: p(mMesAnt, bMesAnt),

          // Variacion sobre el mismo periodo, no sobre el ano cerrado
          variacionPct: vAntYTD ? num((100 * (vAct - vAntYTD)) / vAntYTD) : null,
          variacionMargenPts:
            (p(mAct, bAct) !== null && p(mAntYTD, bAntYTD) !== null)
              ? num(p(mAct, bAct) - p(mAntYTD, bAntYTD)) : null,

          coberturaAntFull: cob(bAntFull, vAntFull),
          coberturaAntYTD: cob(bAntYTD, vAntYTD),
          coberturaAct: cob(bAct, vAct),

          ultimaVenta: pick(r, "UltimaVenta"),
          actualizado: new Date().toISOString(),
        };
      });

      // ── Consolidar clientes recodificados ──
      // En 2026 se cambio la codificacion (U4... -> C0...). El codigo
      // viejo conserva el historico y el nuevo solo tiene ventas de este
      // ano, asi que la comparativa interanual sale rota en ambos.
      // Se agrupan por CODCONTA y el codigo con mas venta actual pasa a
      // ser el principal, heredando el historico del grupo.
      // Clave de agrupacion: codigo contable si existe, y si no,
      // nombre normalizado + poblacion. Los codigos nuevos creados en la
      // migracion de sociedad de marzo de 2026 no llevan CODCONTA, asi
      // que el nombre es la unica via para reconstruir su historico.
      // ?fusion=no  -> solo agrupa por codigo contable
      // ?fusion=off -> no agrupa nada, cada codigo es un cliente
      // Tras corregir los codigos en Power BI (julio 2026) la fusion por
      // nombre deberia sobrar. Se conserva por si reaparecen duplicados.
      const modoFusion = String(req.query.fusion || "si").toLowerCase();
      log.modoFusion = modoFusion;

      let recodificados = 0;
      for (const d of docs) {
        const can = canonico(d.cliente);
        if (can !== d.cliente) { d.canonico = can; recodificados++; }
      }
      log.codigosRecodificados = recodificados;

      const claveGrupo = (d) => {
        // La equivalencia de codigo manda sobre cualquier otra regla
        if (d.canonico) return "CAN:" + d.canonico;
        if (docs.some((x) => x.canonico === d.cliente)) return "CAN:" + d.cliente;
        if (modoFusion === "off") return null;
        if (d.codconta) return "CC:" + d.codconta;
        if (modoFusion === "no") return null;
        const n = normNombre(d.nombre);
        if (!n || n === String(d.cliente).toUpperCase()) return null;
        return "NP:" + n + "|" + String(d.poblacion || "").toUpperCase().trim();
      };

      const porConta = new Map();
      for (const d of docs) {
        const k = claveGrupo(d);
        if (!k) continue;
        d._clave = k;
        if (!porConta.has(k)) porConta.set(k, []);
        porConta.get(k).push(d);
      }

      let fusionados = 0;
      for (const [conta, grupo] of porConta) {
        if (grupo.length < 2) continue;
        // Principal = el que mas ha vendido este ano; si ninguno vende,
        // el que tenga mas historico.
        // En grupos por equivalencia de codigo, el principal es siempre
        // el codigo NUEVO (el que sigue existiendo en el maestro).
        const principal = grupo.find((d) => !d.canonico && !d.huerfano)
          || grupo.slice().sort((a, b) =>
               (b.ventasAct - a.ventasAct) || (b.ventasAntFull - a.ventasAntFull))[0];

        const suma = (k) => grupo.reduce((t, d) => t + (d[k] || 0), 0);

        // IMPORTANTE: las bases limpias se calculan ANTES de sobrescribir
        // los importes del principal. Si no, su cobertura se aplicaria al
        // total del grupo y se contaria dos veces.
        const base = (k, cob) => grupo.reduce(
          (t, d) => t + (d[k] || 0) * ((d[cob] || 0) / 100), 0);
        const bAntFull = base("ventasAntFull", "coberturaAntFull");
        const bAntYTD  = base("ventasAntYTD", "coberturaAntYTD");
        const bAct     = base("ventasAct", "coberturaAct");

        principal.ventasAntFull = num(suma("ventasAntFull"));
        principal.margenAntFull = num(suma("margenAntFull"));
        principal.ventasAntYTD  = num(suma("ventasAntYTD"));
        principal.margenAntYTD  = num(suma("margenAntYTD"));
        principal.ventasAct     = num(suma("ventasAct"));
        principal.margenAct     = num(suma("margenAct"));
        principal.ventasMes     = num(suma("ventasMes"));
        principal.ventasSem     = num(suma("ventasSem"));
        principal.ventasMesAnt  = num(suma("ventasMesAnt"));
        principal.ventasSemAnt  = num(suma("ventasSemAnt"));
        principal.margenSem     = num(suma("margenSem"));
        principal.baseSem       = num(suma("baseSem"));
        principal.margenMes     = num(suma("margenMes"));
        principal.baseMes       = num(suma("baseMes"));
        principal.margenMesAnt  = num(suma("margenMesAnt"));
        principal.baseMesAnt    = num(suma("baseMesAnt"));

        const pct = (m, b) => (b ? num((100 * m) / b) : null);
        const cob = (b, v) => (v ? num((100 * b) / v) : 0);

        principal.margenPctAntFull = pct(principal.margenAntFull, bAntFull);
        principal.margenPctAntYTD  = pct(principal.margenAntYTD, bAntYTD);
        principal.margenPctAct     = pct(principal.margenAct, bAct);
        principal.coberturaAntFull = cob(bAntFull, principal.ventasAntFull);
        principal.coberturaAntYTD  = cob(bAntYTD, principal.ventasAntYTD);
        principal.coberturaAct     = cob(bAct, principal.ventasAct);
        principal.variacionMargenPts =
          (principal.margenPctAct !== null && principal.margenPctAntYTD !== null)
            ? num(principal.margenPctAct - principal.margenPctAntYTD) : null;
        principal.variacionPct = principal.ventasAntYTD
          ? num((100 * (principal.ventasAct - principal.ventasAntYTD)) / principal.ventasAntYTD)
          : null;

        principal.codigosFusionados = grupo.map((d) => d.cliente).join(", ");

        for (const d of grupo) {
          if (d === principal) continue;
          d.fusionadoEn = principal.cliente;   // el CRM puede redirigir aqui
          d.ventasAntFull = 0; d.margenAntFull = 0;
          d.ventasAntYTD = 0;  d.margenAntYTD = 0;
          d.ventasAct = 0;     d.margenAct = 0;
          d.ventasMes = 0;     d.variacionPct = null;
          d.margenPctAntFull = null; d.margenPctAntYTD = null; d.margenPctAct = null;
          d.coberturaAntFull = 0; d.coberturaAntYTD = 0; d.coberturaAct = 0;
          d.variacionMargenPts = null;
          fusionados++;
        }
      }
      log.codigosFusionados = fusionados;
      const multi = [...porConta.entries()].filter(([, g]) => g.length > 1);
      log.gruposPorContable = multi.filter(([k]) => k.startsWith("CC:")).length;
      log.gruposPorNombre = multi.filter(([k]) => k.startsWith("NP:")).length;
      log.sinCodconta = docs.filter((d) => !d.codconta).length;
      // Muestra para revisar a ojo que no se estan fusionando clientes
      // distintos que se llaman parecido
      log.ejemplosFusionPorNombre = multi
        .filter(([k]) => k.startsWith("NP:"))
        .slice(0, 12)
        .map(([k, g]) => ({
          clave: k.slice(3),
          codigos: g.map((d) => `${d.cliente} (${num(d.ventasAct)}€)`).join(" + "),
        }));

      log.intercompanyMarcados = docs.filter((d) => d.intercompany).length;
      log.codigosHuerfanos = docs.filter((d) => d.huerfano).length;
      log.ventaEnHuerfanos = num(docs.filter((d) => d.huerfano)
        .reduce((t, d) => t + d.ventasAntFull, 0));

      // ── Resumen por comercial, para el dashboard ──
      // Se cruza cada cliente con su grupoAgente segun el CRM, porque el
      // codigo de vendedor de Power BI ("1201") no coincide con los
      // agentes del CRM (AZARCO, CARLOSG...).
      try {
        const asignacion = await fbLeerClientes();
        log.clientesCrmLeidos = asignacion.size;

        // En modo incremental, "docs" solo trae los clientes con movimiento.
        // El resumen por comercial necesita la cartera completa, asi que se
        // relee de Firestore y se fusiona: los recien calculados mandan.
        let universo = docs;
        if (desde && !dry) {
          const guardados = await fbLeerColeccion("pbi_ventas_cliente");
          const nuevos = new Map(docs.map((d) => [d._id, d]));

          // Documentos obsoletos: los que quedaron con el codigo antiguo
          // (U43XXXX) cuando su venta ya vive bajo el nuevo (U430XXXX).
          // Si se dejan, la sincronizacion incremental los vuelve a sumar
          // y el total sale inflado. Se descartan y se borran.
          const obsoletos = guardados.filter((g) => {
            const can = canonico(g._id);
            return can !== g._id && (nuevos.has(can) ||
              guardados.some((x) => x._id === can));
          });

          const fuera = new Set(obsoletos.map((o) => o._id));
          universo = guardados
            .filter((g) => !fuera.has(g._id))
            .map((g) => nuevos.get(g._id) || g);
          for (const [id, d] of nuevos) {
            if (!guardados.some((g) => g._id === id)) universo.push(d);
          }

          log.universoResumen = universo.length;
          log.obsoletosPurgados = obsoletos.length;
          if (obsoletos.length) {
            await fbBorrar("pbi_ventas_cliente", obsoletos.map((o) => o._id));
          }
        }

        const porAgente = new Map();
        let sinAsignar = 0, ventaSinAsignar = 0, ventaSinAsignarAnt = 0;
        const huerfanos = [];

        for (const d of universo) {
          if (d.intercompany) continue;            // fuera traspasos internos
          // Los codigos secundarios de una fusion quedan a cero: su venta
          // ya esta sumada en el principal. Contarlos inflaria la cartera
          // y falsearia el recuento de clientes sin venta.
          if (d.fusionadoEn) continue;
          // Prioridad: el comercial que dice Power BI. El CRM queda como
          // respaldo para clientes cuyo vendedor no este en la tabla.
          const agente = d.agente
            || asignacion.get(String(d.cliente).trim())
            || (d.codconta ? asignacion.get("CC:" + d.codconta) : null);
          if (!agente) {
            sinAsignar++;
            ventaSinAsignar += d.ventasAct;
            ventaSinAsignarAnt += d.ventasAntYTD;
            // Se guardan los mayores para poder darlos de alta en el CRM
            if (d.ventasAct > 0) huerfanos.push({
              codigo: d.cliente, nombre: d.nombre, empresa: d.empresa,
              vendedor: d.vendedor, ventas2026: d.ventasAct,
              ventas2025: d.ventasAntFull,
            });
            continue;
          }
          if (!porAgente.has(agente)) {
            porAgente.set(agente, {
              _id: docId(agente), agente, anoAnterior: anoAnt, anoActual: anoAct,
              tipo: d.tipoAgente || null,
              equipo: (globalThis.__AJUSTES_RAMA__ || {})[String(agente).toUpperCase()]
                || ramaDe(d.equipoAgente, d.tipoAgente),
              equipoOriginal: d.equipoAgente || null,
              ambito: d.ambitoAgente || null,
              objetivoMargen: d.objetivoMargen ?? null,
              ventasAntFull: 0, margenAntFull: 0, baseAntFull: 0,
              ventasAntYTD: 0, margenAntYTD: 0, baseAntYTD: 0,
              ventasAct: 0, margenAct: 0, baseAct: 0,
              ventasMes: 0, ventasSem: 0, ventasMesAnt: 0, ventasSemAnt: 0,
              margenMes: 0, baseMes: 0, margenMesAnt: 0, baseMesAnt: 0,
              margenSem: 0, baseSem: 0,
              clientes: 0, clientesConVentaMes: 0,
            });
          }
          d.agente = agente;   // se persiste: permite filtrar por comercial
          const a = porAgente.get(agente);
          a.ventasAntFull += d.ventasAntFull; a.margenAntFull += d.margenAntFull;
          a.ventasAntYTD  += d.ventasAntYTD;  a.margenAntYTD  += d.margenAntYTD;
          a.ventasAct     += d.ventasAct;     a.margenAct     += d.margenAct;
          a.ventasMes     += d.ventasMes;
          a.ventasSem     += d.ventasSem || 0;
          a.ventasMesAnt  += d.ventasMesAnt || 0;
          a.ventasSemAnt  += d.ventasSemAnt || 0;
          a.margenSem     += d.margenSem || 0;
          a.baseSem       += d.baseSem || 0;
          a.margenMes     += d.margenMes || 0;
          a.baseMes       += d.baseMes || 0;
          a.margenMesAnt  += d.margenMesAnt || 0;
          a.baseMesAnt    += d.baseMesAnt || 0;
          a.baseAntFull += d.ventasAntFull * (d.coberturaAntFull / 100);
          a.baseAntYTD  += d.ventasAntYTD  * (d.coberturaAntYTD / 100);
          a.baseAct     += d.ventasAct     * (d.coberturaAct / 100);
          a.clientes++;
          if (d.ventasMes > 0) a.clientesConVentaMes++;
        }

        const cerrar = (a) => {
          const p = (m, b) => (b ? num((100 * m) / b) : null);
          const cob = (b, v) => (v ? num((100 * b) / v) : 0);
          const pctAct = p(a.margenAct, a.baseAct);
          const pctAntYTD = p(a.margenAntYTD, a.baseAntYTD);
          return {
            ...a,
            ventasAntFull: num(a.ventasAntFull), margenAntFull: num(a.margenAntFull),
            ventasAntYTD: num(a.ventasAntYTD),   margenAntYTD: num(a.margenAntYTD),
            ventasAct: num(a.ventasAct),         margenAct: num(a.margenAct),
            ventasMes: num(a.ventasMes),
            ventasSem: num(a.ventasSem),
            ventasMesAnt: num(a.ventasMesAnt),
            margenPctSem:    p(a.margenSem, a.baseSem),
            margenSem: num(a.margenSem),       baseSem: num(a.baseSem),
            margenPctMes:    p(a.margenMes, a.baseMes),
            margenPctMesAnt: p(a.margenMesAnt, a.baseMesAnt),
            margenMes: num(a.margenMes),       baseMes: num(a.baseMes),
            margenMesAnt: num(a.margenMesAnt), baseMesAnt: num(a.baseMesAnt),
            ventasSemAnt: num(a.ventasSemAnt),
            // El % se calcula sobre la venta con coste fiable, no sobre
            // la venta total, o saldria diluido.
            margenPctAntFull: p(a.margenAntFull, a.baseAntFull),
            margenPctAntYTD: pctAntYTD,
            margenPctAct: pctAct,
            variacionPct: a.ventasAntYTD
              ? num((100 * (a.ventasAct - a.ventasAntYTD)) / a.ventasAntYTD) : null,
            // Puntos por encima o por debajo del objetivo de margen
            desviacionObjetivo: (pctAct !== null && a.objetivoMargen)
              ? num(pctAct - a.objetivoMargen) : null,
            variacionMargenPts: (pctAct !== null && pctAntYTD !== null)
              ? num(pctAct - pctAntYTD) : null,
            coberturaAntFull: cob(a.baseAntFull, a.ventasAntFull),
            coberturaAntYTD: cob(a.baseAntYTD, a.ventasAntYTD),
            coberturaAct: cob(a.baseAct, a.ventasAct),
            baseAntFull: num(a.baseAntFull), baseAntYTD: num(a.baseAntYTD),
            baseAct: num(a.baseAct),
          };
        };

        const resumen = [...porAgente.values()].map(cerrar);

        const tot = [...porAgente.values()].reduce((t, a) => {
          for (const k of ["ventasAntFull","margenAntFull","baseAntFull",
                           "ventasAntYTD","margenAntYTD","baseAntYTD",
                           "ventasAct","margenAct","baseAct","ventasMes","ventasSem",
                           "ventasMesAnt","ventasSemAnt",
                           "margenMes","baseMes","margenMesAnt","baseMesAnt",
                           "margenSem","baseSem",
                           "clientes","clientesConVentaMes"]) t[k] += a[k];
          return t;
        }, { _id: "_TOTAL", agente: "_TOTAL", anoAnterior: anoAnt, anoActual: anoAct,
             ventasAntFull:0, margenAntFull:0, baseAntFull:0,
             ventasAntYTD:0, margenAntYTD:0, baseAntYTD:0,
             ventasAct:0, margenAct:0, baseAct:0, ventasMes:0, ventasSem:0,
             ventasMesAnt:0, ventasSemAnt:0,
             margenMes:0, baseMes:0, margenMesAnt:0, baseMesAnt:0,
             margenSem:0, baseSem:0,
             clientes:0, clientesConVentaMes:0 });
        resumen.push(cerrar(tot));

        log.agentes = resumen.length - 1;
        log.clientesSinAgente = sinAsignar;
        log.ventaSinAsignar = num(ventaSinAsignar);
        log.ventaSinAsignarAnt = num(ventaSinAsignarAnt);
        // Comparacion honesta: si el ano anterior casi todo estaba asignado
        // y este ano falta mucho, la caida del -35% es un espejismo
        log.ventaTotalReal = {
          ant: num(ventaSinAsignarAnt + [...porAgente.values()]
                 .reduce((t, a) => t + a.ventasAntYTD, 0)),
          act: num(ventaSinAsignar + [...porAgente.values()]
                 .reduce((t, a) => t + a.ventasAct, 0)),
        };
        log.ventaTotalReal.variacionPct = log.ventaTotalReal.ant
          ? num(100 * (log.ventaTotalReal.act - log.ventaTotalReal.ant) / log.ventaTotalReal.ant)
          : null;
        log.topSinAsignar = huerfanos
          .sort((a, b) => b.ventas2026 - a.ventas2026)
          .slice(0, 25)
          .map((h) => ({ ...h, ventas2026: num(h.ventas2026), ventas2025: num(h.ventas2025) }));
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

    // ── 1 bis. Pedidos planificados ──
    // Con margen de tiempo: si la consulta de ventas ya se ha comido casi
    // todo el limite de Vercel, se salta y entra en la siguiente pasada.
    // Mas vale una sincronizacion parcial que un timeout que no escribe nada.
    const quedanSegundos = () => 55 - Math.round((Date.now() - t0) / 1000);
    if (activo("pedidos") && quedanSegundos() < 12) {
      log.pedidos = `omitido, quedaban ${quedanSegundos()} s`;
    } else if (activo("pedidos")) try {
      // Maestro de articulos, para poner descripcion en cada linea
      const arts = new Map();
      try {
        for (const a of await pbiQuery(token, Q.articulos, true)) {
          const cod = String(pick(a, "CODIGO") || "").trim();
          if (!cod || arts.has(cod)) continue;
          arts.set(cod, {
            descripcion: pick(a, "DESCRIPCION"),
            metros: pick(a, "METROS"),
            calibre: pick(a, "CALIBRE"),
            calidad: pick(a, "CALIDAD"),
          });
        }
      } catch (e) { /* sin maestro se muestra solo el codigo */ }

      const filas = await pbiQuery(token, Q.pedidos);
      const docs = filas.map((r, i) => {
        const cli = String(pick(r, "Cliente") || "").trim();
        const ven = String(pick(r, "Vendedor") || "").trim();
        const fec = String(pick(r, "Fecha") || "").slice(0, 10);
        const art = String(pick(r, "Articulo") || "").trim();
        const ficha = fichas.get(cli) || fichas.get(canonico(cli)) || {};
        return {
          _id: docId(`${fec}_${cli}_${art}_${i}`),
          cliente: cli,
          nombre: ficha.nombre || cli,
          poblacion: ficha.poblacion || null,
          agente: agentes.get(ven)?.grupo || null,
          vendedor: ven,
          fecha: fec,
          articulo: art,
          familia: String(pick(r, "Familia") || "").trim() || null,
          unidades: num(pick(r, "Uni")),
          precio: num(pick(r, "Precio")),
          descripcion: (arts.get(art) || {}).descripcion || null,
          metros: (arts.get(art) || {}).metros || null,
          calibre: (arts.get(art) || {}).calibre || null,
          calidad: (arts.get(art) || {}).calidad || null,
          subfamilia: String(pick(r, "Subfamilia") || "").trim() || null,
          importe: num(pick(r, "Importe")),
          pedido: String(pick(r, "Pedido") || "").trim(),
          // Traspasos entre empresas del grupo: mismo criterio que en ventas
          intercompany: esIntercompany(ficha.nombre || cli),
          actualizado: new Date().toISOString(),
        };
      }).filter((d) => d.cliente && d.fecha);

      log.pedidos = dry ? docs.length : await fbCommit("pbi_pedidos", docs);

      // Los pedidos ya servidos deben desaparecer: si no, el comercial
      // acabaria viendo entregas de la semana pasada mezcladas con las suyas.
      if (!dry) {
        try {
          const hoyISO = new Date().toISOString().slice(0, 10);
          const guardados = await fbLeerColeccion("pbi_pedidos");
          const caducados = guardados
            .filter((g) => !g.fecha || String(g.fecha) < hoyISO)
            .map((g) => g._id);
          log.pedidosCaducados = caducados.length;
          if (caducados.length) await fbBorrar("pbi_pedidos", caducados);
        } catch (e) {
          log.errores.push(`purga pedidos: ${e.message}`);
        }
      }
      log.pedidosImporte = num(docs.reduce((t, d) => t + d.importe, 0));
      if (dry) log.muestraPedidos = docs.slice(0, 3);
    } catch (e) {
      log.errores.push(`pedidos: ${e.message}`);
    }
    else log.pedidos = "desactivado";

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
