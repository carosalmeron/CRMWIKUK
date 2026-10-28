// api/sap-traslado.js — Solicitudes de traslado y traslados de stock entre almacenes en SAP Business One (Service Layer)
//
// Mismas variables y clave que sap-pedido.js (SAP_URL, SAP_DB, SAP_USER, SAP_PASS, SAP_INSECURE/SAP_CA, SAP_PEDIDOS_KEY).
// GET  ?almacenes=1                         → almacenes activos
// GET  ?articulos=texto                     → artículos con stock por almacén
// GET  ?lotes=ITEM[&almacen=WHS]            → lotes con existencias
// GET  ?solicitudes=1[&destino=WHS]         → solicitudes de traslado abiertas (para confirmar la recepción)
// POST { accion:"solicitar", solicitud:{ origen, destino, fecha?, comentario?, ref?, lineas:[{ articulo, uds, lote? }] } }
//      → crea la solicitud de traslado (InventoryTransferRequests). El lote va en el texto de la línea («Lote: X»).
// POST { accion:"confirmar", entry, fecha?, lineas:[{ linea, uds, lotes:[{lote, uds}] }] }
//      → crea el traslado de stock (StockTransfers) enlazado a la solicitud: la mercancía pasa al almacén destino.
//
const https = require("https");
const { URL } = require("url");
const env = (k) => { const v = process.env[k]; return v === undefined ? undefined : String(v).trim(); };

function pedir(base, ruta, { method = "GET", body, cookies = "", ca, insecure } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(ruta, base); const datos = body ? JSON.stringify(body) : null;
    const opts = { method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      headers: { "Content-Type": "application/json", Accept: "application/json", Prefer: "odata.maxpagesize=50", ...(cookies ? { Cookie: cookies } : {}), ...(datos ? { "Content-Length": Buffer.byteLength(datos) } : {}) },
      timeout: 25000, ...(ca ? { ca } : {}), ...(insecure ? { rejectUnauthorized: false } : {}) };
    const req = https.request(opts, (res) => { let buf = ""; res.setEncoding("utf8"); res.on("data", (c) => buf += c);
      res.on("end", () => { let j = null; try { j = buf ? JSON.parse(buf) : null; } catch (e) {} resolve({ status: res.statusCode, headers: res.headers, json: j, texto: buf.slice(0, 500) }); }); });
    req.on("timeout", () => req.destroy(new Error("tiempo agotado conectando con SAP")));
    req.on("error", reject); if (datos) req.write(datos); req.end();
  });
}
const msgDe = (r) => { const m = r.json && r.json.error && r.json.error.message; return (m && (m.value || m)) || r.texto || ("HTTP " + r.status); };
async function conSesion(db, fn) {
  if (!env("SAP_URL") || !env("SAP_USER") || !env("SAP_PASS")) throw new Error("faltan SAP_URL, SAP_USER o SAP_PASS en Vercel");
  const base = env("SAP_URL").replace(/\/+$/, "") + "/b1s/v1/", ca = env("SAP_CA") ? env("SAP_CA").replace(/\\n/g, "\n") : undefined, insecure = env("SAP_INSECURE") === "1";
  const login = await pedir(base, "Login", { method: "POST", body: { CompanyDB: db, UserName: env("SAP_USER"), Password: env("SAP_PASS") }, ca, insecure });
  if (login.status !== 200) throw new Error("login SAP " + login.status + ": " + msgDe(login));
  const cookies = (login.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
  const get = async (ruta) => { const r = await pedir(base, ruta, { cookies, ca, insecure }); if (r.status >= 300) throw new Error(ruta.split("?")[0] + " → " + r.status + ": " + msgDe(r)); return r.json; };
  const post = async (ruta, body) => { const r = await pedir(base, ruta, { method: "POST", body, cookies, ca, insecure }); if (r.status >= 300) throw new Error("SAP no ha aceptado " + ruta + " (" + r.status + "): " + msgDe(r)); return r.json; };
  const patch = async (ruta, body) => { const r = await pedir(base, ruta, { method: "PATCH", body, cookies, ca, insecure }); if (r.status >= 300) throw new Error("SAP no ha aceptado el cambio en " + ruta + " (" + r.status + "): " + msgDe(r)); return r.json; };
  try { return await fn({ get, post, patch }); }
  finally { try { await pedir(base, "Logout", { method: "POST", cookies, ca, insecure }); } catch (e) {} }
}
const esc = (s) => String(s || "").replace(/'/g, "''");
const DB_OK = (d) => /^[A-Z0-9_]+$/i.test(String(d || ""));

// Acepta la clave SAP_PEDIDOS_KEY o el pase firmado que da /api/sap-token al entrar en el portal (30 días)
function autorizado(dada) {
  const clave = env("SAP_PEDIDOS_KEY") || env("CRON_SECRET"); if (!clave) return { ok: true };
  if (dada === clave) return { ok: true, quien: "clave" };
  const m = String(dada || "").match(/^crm\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/); if (!m) return { ok: false };
  const h = require("crypto").createHmac("sha256", clave).update(m[1]).digest("base64url"); if (h !== m[2]) return { ok: false };
  try { const p = JSON.parse(Buffer.from(m[1], "base64url").toString()); if (!(p.exp > Date.now())) return { ok: false, caducado: true }; return { ok: true, quien: p.n || p.u }; } catch (e) { return { ok: false }; }
}
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-crm-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  const q = req.query || {};
  const AUT = autorizado(req.headers["x-crm-key"] || q.key || "");
  if (!AUT.ok) return res.status(401).json({ ok: false, error: AUT.caducado ? "el pase ha caducado: vuelve a entrar en el portal" : "clave incorrecta" });
  let body = req.body; if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const db = String((body && body.db) || q.db || env("SAP_DB") || "U_CARO_00"); if (!DB_OK(db)) return res.status(400).json({ ok: false, error: "base de datos no válida" });
  const out = { ok: true, db }; const t0 = Date.now();
  const F = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
  try {
    await conSesion(db, async (sl) => {
      if (req.method === "GET" && q.almacenes !== undefined) {
        const r = await sl.get("Warehouses?$select=WarehouseCode,WarehouseName,Inactive&$orderby=WarehouseCode");
        out.almacenes = (r.value || []).filter((w) => w.Inactive !== "tYES").map((w) => ({ codigo: w.WarehouseCode, nombre: w.WarehouseName })); return;
      }
      if (req.method === "GET" && q.articulos !== undefined) {
        const t = esc(String(q.articulos || "").trim().toUpperCase()); if (t.length < 2) { out.articulos = []; return; }
        const r = await sl.get(`Items?$select=ItemCode,ItemName,QuantityOnStock,ManageBatchNumbers,Valid,ItemWarehouseInfoCollection&$filter=Valid eq 'tYES' and (startswith(ItemCode,'${t}') or contains(ItemName,'${t}'))&$orderby=ItemCode&$top=25`);
        out.articulos = (r.value || []).map((i) => ({ codigo: i.ItemCode, nombre: i.ItemName, stock: i.QuantityOnStock, porLotes: i.ManageBatchNumbers === "tYES",
          porAlmacen: Object.fromEntries((i.ItemWarehouseInfoCollection || []).filter((w) => Number(w.InStock) > 0).map((w) => [w.WarehouseCode, Number(w.InStock)])) })); return;
      }
      if (req.method === "GET" && q.lotes) {
        const item = String(q.lotes).toUpperCase(), alm = q.almacen ? String(q.almacen).toUpperCase() : ""; let lotes = null;
        try { const r = await sl.get(`SQLQueries('CRM_LotesStock')/List?ItemCode='${esc(item)}'`); lotes = r.value || []; } catch (e) { out.avisoSql = String(e.message || e).slice(0, 160); }
        if (lotes) { out.lotes = lotes.map((l) => ({ lote: l.BatchNum, almacen: l.WhsCode, cantidad: Number(l.Quantity) || 0, caducidad: String(l.ExpDate || "").slice(0, 10) || null })).filter((l) => !alm || l.almacen === alm); return; }
        const r = await sl.get(`BatchNumberDetails?$select=Batch,ItemCode,Status,ExpirationDate,AdmissionDate&$filter=ItemCode eq '${esc(item)}' and Status eq 'bdsStatus_Released'&$orderby=AdmissionDate desc&$top=50`);
        out.lotes = (r.value || []).map((l) => ({ lote: l.Batch, almacen: alm || null, cantidad: null, caducidad: String(l.ExpirationDate || "").slice(0, 10) || null })); return;
      }
      if (req.method === "GET" && q.solicitudes !== undefined) {
        const dest = q.destino ? String(q.destino).toUpperCase() : "";
        const r = await sl.get(`InventoryTransferRequests?$select=DocEntry,DocNum,DocDate,DueDate,FromWarehouse,ToWarehouse,Comments,JournalMemo,DocumentStatus,StockTransferLines&$filter=DocumentStatus eq 'bost_Open'&$orderby=DocEntry desc&$top=100`);
        out.solicitudes = (r.value || []).filter((d) => !dest || d.ToWarehouse === dest || (d.StockTransferLines || []).some((l) => l.WarehouseCode === dest)).map((d) => ({ entry: d.DocEntry, num: d.DocNum, fecha: String(d.DocDate || "").slice(0, 10), para: String(d.DueDate || "").slice(0, 10),
          origen: d.FromWarehouse, destino: d.ToWarehouse, comentario: d.Comments || "",
          lineas: (d.StockTransferLines || []).filter((l) => l.LineStatus !== "bost_Close").map((l) => { const m = String(l.FreeText || "").match(/lote[:\s]+([A-Z0-9.\-\/]+)/i);
            return { linea: l.LineNum, articulo: l.ItemCode, descripcion: l.ItemDescription, uds: Number(l.RemainingOpenQuantity ?? l.Quantity) || 0, origen: l.FromWarehouseCode || d.FromWarehouse, destino: l.WarehouseCode || d.ToWarehouse, lote: m ? m[1] : "", texto: l.FreeText || "" }; }) }))
          .filter((d) => d.lineas.length); return;
      }
      if (req.method === "POST" && body && body.accion === "solicitar") {
        const p = body.solicitud || {}; if (!p.origen || !p.destino) throw new Error("faltan almacén de origen o destino"); if (p.origen === p.destino) throw new Error("origen y destino son el mismo almacén");
        const L = (p.lineas || []).filter((l) => l && l.articulo && Number(l.uds) > 0); if (!L.length) throw new Error("no hay líneas");
        const hoy = new Date().toISOString().slice(0, 10);
        const doc = { DocDate: F(p.fecha) ? p.fecha : hoy, DueDate: F(p.para) ? p.para : (F(p.fecha) ? p.fecha : hoy), FromWarehouse: String(p.origen), ToWarehouse: String(p.destino),
          Comments: (String(p.comentario || "") + (p.ref ? " · " + p.ref : "")).slice(0, 254) || undefined,
          StockTransferLines: L.map((l) => ({ ItemCode: String(l.articulo), Quantity: Number(l.uds), FromWarehouseCode: String(p.origen), WarehouseCode: String(p.destino), FreeText: l.lote ? ("Lote: " + l.lote).slice(0, 100) : undefined })) };
        out.enviado = doc;
        const r = await sl.post("InventoryTransferRequests", doc);
        out.solicitud = { entry: r.DocEntry, num: r.DocNum, origen: r.FromWarehouse, destino: r.ToWarehouse, lineas: (r.StockTransferLines || []).map((l) => ({ articulo: l.ItemCode, uds: l.Quantity })) };
        out.mensaje = "Solicitud de traslado " + r.DocNum + " creada (" + r.FromWarehouse + " → " + r.ToWarehouse + ")"; return;
      }
      if (req.method === "POST" && body && body.accion === "confirmar") {
        const entry = Number(body.entry); if (!(entry > 0)) throw new Error("falta la solicitud");
        const s = await sl.get(`InventoryTransferRequests(${entry})`);
        const hoy = new Date().toISOString().slice(0, 10);
        const L = (body.lineas || []).filter((l) => l && Number(l.uds) > 0); if (!L.length) throw new Error("no hay cantidades a trasladar");
        const lin = (n) => (s.StockTransferLines || []).find((x) => Number(x.LineNum) === Number(n));
        const doc = { DocDate: F(body.fecha) ? body.fecha : hoy, FromWarehouse: s.FromWarehouse, ToWarehouse: s.ToWarehouse, Comments: ("Recepción de la solicitud " + s.DocNum + " (CRM)").slice(0, 254),
          StockTransferLines: L.map((l) => { const x = lin(l.linea); if (!x) throw new Error("la línea " + l.linea + " no está en la solicitud");
            const d = { ItemCode: x.ItemCode, Quantity: Number(l.uds), FromWarehouseCode: x.FromWarehouseCode || s.FromWarehouse, WarehouseCode: x.WarehouseCode || s.ToWarehouse, BaseType: "InventoryTransferRequest", BaseEntry: entry, BaseLine: x.LineNum };
            const lotes = (l.lotes || []).filter((b) => b && b.lote && Number(b.uds) > 0);
            if (lotes.length) { const sum = lotes.reduce((t, b) => t + Number(b.uds), 0); if (Math.abs(sum - Number(l.uds)) > 0.0001) throw new Error("en " + x.ItemCode + " los lotes suman " + sum + " y se trasladan " + l.uds); d.BatchNumbers = lotes.map((b) => ({ BatchNumber: String(b.lote), Quantity: Number(b.uds) })); }
            return d; }) };
        out.enviado = doc;
        let r; try { r = await sl.post("StockTransfers", doc); }
        catch (e) { if (/BaseType/i.test(String(e.message))) { doc.StockTransferLines.forEach((d) => { d.BaseType = 1250000001; }); r = await sl.post("StockTransfers", doc); } else throw e; }
        out.traslado = { entry: r.DocEntry, num: r.DocNum, origen: r.FromWarehouse, destino: r.ToWarehouse, lineas: (r.StockTransferLines || []).map((l) => ({ articulo: l.ItemCode, uds: l.Quantity, lotes: (l.BatchNumbers || []).map((b) => ({ lote: b.BatchNumber, uds: b.Quantity })) })) };
        out.mensaje = "Traslado " + r.DocNum + " hecho: " + r.FromWarehouse + " → " + r.ToWarehouse + " (solicitud " + s.DocNum + ")"; return;
      }
      throw new Error("petición no reconocida");
    });
  } catch (e) { out.ok = false; out.error = String(e.message || e).slice(0, 600); }
  out.segundos = Math.round((Date.now() - t0) / 100) / 10;
  return res.status(out.ok ? 200 : 400).json(out);
};
