// api/sap-test.js — Prueba de conexión del CRM con SAP Business One (Service Layer)
//
// Variables de entorno en Vercel (Settings → Environment Variables):
//    SAP_URL      https://85.63.64.76:50000        (sin /b1s/v1; se añade aquí)
//    SAP_DB       U_CARO_00                        (real) · U_CARO_99 (pruebas)
//    SAP_USER     usuario de SAP
//    SAP_PASS     clave
//    SAP_CA       (opcional) certificado del Service Layer en PEM, para verificar https sin avisos
//    SAP_INSECURE (opcional) "1" para aceptar el certificado autofirmado del servidor sin verificarlo
//    CRON_SECRET  el mismo que usa pbi-sync
//
// Uso (con el secreto):
//    /api/sap-test?secret=…              → entra, cuenta pedidos abiertos y enseña los 5 primeros
//    /api/sap-test?secret=…&db=U_CARO_99 → lo mismo contra la base de pruebas
//    /api/sap-test?secret=…&pedidos=1    → líneas de pedidos de venta abiertos (hasta 200)
//    /api/sap-test?secret=…&stock=1      → stock por artículo y almacén (hasta 200)
//    /api/sap-test?secret=…&estados=1    → qué estados y fechas hay de verdad en los pedidos (cabecera y líneas)
//    /api/sap-test?secret=…&que=Items&top=5   → cualquier entidad del Service Layer, para explorar
//
// Siempre cierra la sesión al terminar (Logout) para no dejar ocupada una licencia de SAP.

const https = require("https");
const { URL } = require("url");

const env = (k) => { const v = process.env[k]; return v === undefined ? undefined : String(v).trim(); };

// Petición https propia: el Service Layer de B1 suele ir con certificado autofirmado y el fetch de Node lo rechaza.
function pedir(base, ruta, { method = "GET", body, cookies = "", ca, insecure } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(ruta, base);
    const datos = body ? JSON.stringify(body) : null;
    const opts = { method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      headers: { "Content-Type": "application/json", "Accept": "application/json", ...(cookies ? { Cookie: cookies } : {}), ...(datos ? { "Content-Length": Buffer.byteLength(datos) } : {}) },
      timeout: 25000, ...(ca ? { ca } : {}), ...(insecure ? { rejectUnauthorized: false } : {}) };
    const req = https.request(opts, (res) => {
      let buf = ""; res.setEncoding("utf8"); res.on("data", (c) => buf += c);
      res.on("end", () => { let j = null; try { j = buf ? JSON.parse(buf) : null; } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, json: j, texto: buf.slice(0, 400) }); });
    });
    req.on("timeout", () => { req.destroy(new Error("tiempo agotado (25 s) conectando con " + u.hostname + ":" + (u.port || 443))); });
    req.on("error", reject);
    if (datos) req.write(datos);
    req.end();
  });
}

async function conSesion(db, fn) {
  const base = (env("SAP_URL") || "").replace(/\/+$/, "") + "/b1s/v1/";
  if (!env("SAP_URL") || !env("SAP_USER") || !env("SAP_PASS")) throw new Error("faltan SAP_URL, SAP_USER o SAP_PASS en Vercel");
  const ca = env("SAP_CA") ? env("SAP_CA").replace(/\\n/g, "\n") : undefined, insecure = env("SAP_INSECURE") === "1";
  const t0 = Date.now();
  const login = await pedir(base, "Login", { method: "POST", body: { CompanyDB: db, UserName: env("SAP_USER"), Password: env("SAP_PASS") }, ca, insecure });
  if (login.status !== 200) { const m = login.json && login.json.error && login.json.error.message; throw new Error("login " + login.status + ": " + (m && (m.value || m) || login.texto)); }
  const setc = login.headers["set-cookie"] || [];
  const cookies = setc.map((c) => c.split(";")[0]).join("; ");
  const sl = { base, cookies, ca, insecure, msLogin: Date.now() - t0, version: login.json && login.json.Version,
    get: async (ruta) => { const r = await pedir(base, ruta, { cookies, ca, insecure }); if (r.status >= 300) { const m = r.json && r.json.error && r.json.error.message; throw new Error(ruta.split("?")[0] + " → " + r.status + ": " + (m && (m.value || m) || r.texto)); } return r.json; } };
  try { return await fn(sl); }
  finally { try { await pedir(base, "Logout", { method: "POST", cookies, ca, insecure }); } catch (e) {} }
}

// Paginación del Service Layer: trae hasta `max` filas siguiendo odata.nextLink
async function todas(sl, ruta, max = 200) {
  let out = [], r = await sl.get(ruta);
  out.push(...(r.value || []));
  while (r["odata.nextLink"] && out.length < max) { r = await sl.get(r["odata.nextLink"].replace(/^\/?b1s\/v1\//, "")); out.push(...(r.value || [])); }
  return out.slice(0, max);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = req.query || {};
  const sec = env("CRON_SECRET");
  if (sec && q.secret !== sec) return res.status(401).json({ error: "no autorizado" });
  const db = String(q.db || env("SAP_DB") || "U_CARO_00");
  const out = { ok: true, db, url: env("SAP_URL"), verificacionTLS: env("SAP_CA") ? "certificado propio (SAP_CA)" : env("SAP_INSECURE") === "1" ? "SIN verificar (SAP_INSECURE=1)" : "estándar" };
  const t0 = Date.now();
  try {
    await conSesion(db, async (sl) => {
      out.loginMs = sl.msLogin; out.serviceLayer = sl.version || null;
      if (q.que) {   // explorar cualquier entidad
        const top = Math.min(Number(q.top) || 5, 50);
        out.entidad = String(q.que); out.filas = (await sl.get(`${encodeURIComponent(String(q.que))}?$top=${top}${q.select ? "&$select=" + encodeURIComponent(String(q.select)) : ""}${q.filter ? "&$filter=" + encodeURIComponent(String(q.filter)) : ""}`)).value;
        return;
      }
      if (q.estados === "1") {   // qué estados y qué fechas hay de verdad en los pedidos (últimos 400)
        const ped = await todas(sl, "Orders?$orderby=DocEntry desc", Math.min(Number(q.top) || 400, 1000));
        const cab = {}, lin = {}, fechasCab = {}, fechasLin = {};
        const esFecha = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);
        const cuenta = (o, k, v) => { const m = o[k] = o[k] || {}; const s = v === null || v === undefined ? "(vacío)" : String(v); m[s] = (m[s] || 0) + 1; };
        const CAB = ["DocumentStatus", "Cancelled", "Confirmed", "AuthorizationStatus", "Printed", "DocObjectCode", "DocumentSubType", "Indicator", "PaymentBlock", "ReserveInvoice", "DocType"];
        const LIN = ["LineStatus", "TreeType", "WarehouseCode", "SalesPersonCode"];
        for (const p of ped) {
          for (const k of Object.keys(p)) { if (CAB.includes(k) || /^U_/.test(k) && !esFecha(p[k]) && typeof p[k] !== "object") cuenta(cab, k, p[k]); if (esFecha(p[k])) { const f = fechasCab[k] = fechasCab[k] || { con: 0, sin: 0, min: null, max: null }; f.con++; const d = p[k].slice(0, 10); if (!f.min || d < f.min) f.min = d; if (!f.max || d > f.max) f.max = d; } else if (/Date$/.test(k)) { const f = fechasCab[k] = fechasCab[k] || { con: 0, sin: 0, min: null, max: null }; f.sin++; } }
          for (const l of (p.DocumentLines || [])) for (const k of Object.keys(l)) { if (LIN.includes(k) || /^U_/.test(k) && !esFecha(l[k]) && typeof l[k] !== "object") cuenta(lin, k, l[k]); if (esFecha(l[k])) { const f = fechasLin[k] = fechasLin[k] || { con: 0, sin: 0, min: null, max: null }; f.con++; const d = l[k].slice(0, 10); if (!f.min || d < f.min) f.min = d; if (!f.max || d > f.max) f.max = d; } else if (/Date$/.test(k)) { const f = fechasLin[k] = fechasLin[k] || { con: 0, sin: 0, min: null, max: null }; f.sin++; } }
        }
        // Solo los campos con más de un valor o con campos U_ (los fijos de un solo valor no dicen nada)
        const util = (o) => Object.fromEntries(Object.entries(o).filter(([k, m]) => Object.keys(m).length > 1 || /^U_/.test(k) || ["DocumentStatus", "Cancelled", "LineStatus"].includes(k)).map(([k, m]) => [k, Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 12))]));
        out.pedidosLeidos = ped.length; out.estadosCabecera = util(cab); out.estadosLinea = util(lin); out.fechasCabecera = fechasCab; out.fechasLinea = fechasLin;
        return;
      }
      if (q.pedidos === "1") {   // líneas abiertas de pedidos de venta
        const ped = await todas(sl, "Orders?$select=DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal,DocumentStatus,SalesPersonCode,DocumentLines&$filter=DocumentStatus eq 'bost_Open'&$orderby=DocDate desc", Math.min(Number(q.top) || 100, 300));
        const lineas = [];
        for (const p of ped) for (const l of (p.DocumentLines || [])) if ((l.RemainingOpenQuantity ?? l.OpenQuantity ?? 0) > 0)
          lineas.push({ pedido: p.DocNum, fecha: p.DocDate, entrega: l.ShipDate || p.DocDueDate, cliente: p.CardCode, nombre: p.CardName, vendedor: p.SalesPersonCode,
            articulo: l.ItemCode, descripcion: l.ItemDescription, uds: l.Quantity, pendientes: l.RemainingOpenQuantity ?? l.OpenQuantity, precio: l.Price, importe: l.LineTotal, almacen: l.WarehouseCode });
        out.pedidosAbiertos = ped.length; out.lineasAbiertas = lineas.length; out.importeLineas = Math.round(lineas.reduce((t, l) => t + (Number(l.importe) || 0), 0) * 100) / 100;
        out.lineas = lineas.slice(0, 200);
        return;
      }
      if (q.stock === "1") {   // stock por artículo y almacén
        const its = await todas(sl, "Items?$select=ItemCode,ItemName,QuantityOnStock,QuantityOrderedFromVendors,QuantityOrderedByCustomers,ItemWarehouseInfoCollection&$filter=QuantityOnStock gt 0", Math.min(Number(q.top) || 200, 1000));
        out.articulosConStock = its.length;
        out.stock = its.map((i) => ({ codigo: i.ItemCode, nombre: i.ItemName, stock: i.QuantityOnStock, pedidoAProveedor: i.QuantityOrderedFromVendors, comprometido: i.QuantityOrderedByCustomers,
          almacenes: (i.ItemWarehouseInfoCollection || []).filter((w) => (w.InStock || 0) > 0).map((w) => ({ alm: w.WarehouseCode, stock: w.InStock, comprometido: w.Committed, pedido: w.Ordered })) })).slice(0, 200);
        return;
      }
      // Prueba básica
      const n = await sl.get("$crossjoin(Orders)/$count?$filter=Orders/DocumentStatus eq 'bost_Open'").catch(() => null);
      const ult = await sl.get("Orders?$select=DocNum,DocDate,CardCode,CardName,DocTotal,DocumentStatus&$orderby=DocEntry desc&$top=5");
      const cli = await sl.get("BusinessPartners?$select=CardCode,CardName&$filter=CardType eq 'cCustomer'&$top=3");
      out.pedidosAbiertos = typeof n === "number" ? n : (n && n.value) || "no disponible";
      out.ultimosPedidos = ult.value; out.ejemploClientes = cli.value;
      out.mensaje = "Conecta bien. Ya se puede leer SAP desde el CRM.";
    });
  } catch (e) {
    out.ok = false; out.error = String(e.message || e).slice(0, 500);
    if (/ECONNREFUSED|ETIMEDOUT|tiempo agotado|EHOSTUNREACH|ENETUNREACH/.test(out.error)) out.pista = "No se llega al servidor: el puerto 50000 no está abierto hacia internet (o la IP no es esa). Hay que abrirlo en el router/firewall solo para https, o poner el Service Layer detrás de un proxy con certificado.";
    else if (/certificate|self signed|SELF_SIGNED|unable to verify|CERT_/i.test(out.error)) out.pista = "El certificado del Service Layer es autofirmado. Opción buena: pegar el certificado (PEM) en SAP_CA. Opción rápida: SAP_INSECURE=1 (no verifica el certificado).";
    else if (/login 401|Invalid|incorrect|password|usuario|user/i.test(out.error)) out.pista = "Usuario, clave o base de datos incorrectos (SAP_USER, SAP_PASS, SAP_DB). Prueba con &db=U_CARO_99.";
    else if (/license|licen/i.test(out.error)) out.pista = "Sin licencia libre para ese usuario: ese usuario está en uso en el cliente de SAP. Hay que usar otro usuario o cerrar su sesión.";
  }
  out.segundos = Math.round((Date.now() - t0) / 100) / 10;
  return res.status(200).json(out);
};
