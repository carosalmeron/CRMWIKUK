// api/sap-produccion.js — Parte de producción en SAP Business One (Service Layer): orden de fabricación + baja de
// componentes (salida para producción) + alta del producto con lote nuevo (entrada de producción)
//
// Variables en Vercel (las mismas que sap-test.js): SAP_URL, SAP_DB, SAP_USER, SAP_PASS, SAP_INSECURE / SAP_CA
//   + SAP_PEDIDOS_KEY  clave que debe mandar la página (cabecera x-crm-key). Si no existe, se admite CRON_SECRET.
//
// GET  ?articulos=texto               → artículos (código o descripción) con stock
// GET  ?escandallo=ITEM               → lista de materiales de SAP (ProductTrees): componentes, cantidades base y almacenes
// GET  ?lotes=ITEM[&almacen=WHS]      → lotes con existencias (igual que sap-factura.js)
// GET  ?almacenes=1                   → almacenes activos
// GET  ?orden=NUM                     → una orden de fabricación con sus líneas (para comprobar)
// POST { db?, parte:{ producto, cantidad, almacen, fecha?, loteNuevo, caducidad?, fabricacion?, comentario?, cerrar?,
//                     componentes:[{ articulo, uds, almacen?, lotes:[{lote, uds}] }] } }
//   1) crea la orden de fabricación (liberada) con esos componentes
//   2) salida de mercancías para producción: da de baja los componentes (con sus lotes) enlazada a la orden
//   3) entrada de mercancías de producción: da de alta la cantidad fabricada con el lote nuevo, enlazada a la orden
//   4) si cerrar=true, cierra la orden. Devuelve los tres documentos de SAP.
//
// Siempre cierra la sesión (Logout) para no ocupar la licencia.

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

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-crm-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  const q = req.query || {};
  const clave = env("SAP_PEDIDOS_KEY") || env("CRON_SECRET");
  const dada = req.headers["x-crm-key"] || q.key || "";
  if (clave && dada !== clave) return res.status(401).json({ ok: false, error: "clave incorrecta" });
  let body = req.body; if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const db = String((body && body.db) || q.db || env("SAP_DB") || "U_CARO_00"); if (!DB_OK(db)) return res.status(400).json({ ok: false, error: "base de datos no válida" });
  const out = { ok: true, db };
  const t0 = Date.now();
  try {
    await conSesion(db, async (sl) => {
      if (req.method === "GET" && q.articulos !== undefined) {
        const t = esc(String(q.articulos || "").trim().toUpperCase()); if (t.length < 2) { out.articulos = []; return; }
        const r = await sl.get(`Items?$select=ItemCode,ItemName,QuantityOnStock,ManageBatchNumbers,TreeType,Valid&$filter=Valid eq 'tYES' and (startswith(ItemCode,'${t}') or contains(ItemName,'${t}'))&$orderby=ItemCode&$top=25`);
        out.articulos = (r.value || []).map((i) => ({ codigo: i.ItemCode, nombre: i.ItemName, stock: i.QuantityOnStock, porLotes: i.ManageBatchNumbers === "tYES", conEscandallo: i.TreeType === "iProductionTree" || i.TreeType === "iAssemblyTree" }));
        return;
      }
      if (req.method === "GET" && q.escandallo) {
        const cod = String(q.escandallo).toUpperCase();
        let t = null; try { t = await sl.get(`ProductTrees('${esc(cod)}')`); } catch (e) { throw new Error("ese artículo no tiene escandallo en SAP (" + String(e.message || e).slice(0, 120) + ")"); }
        const L = (t.ProductTreeLines || []).filter((l) => l.ItemType === "pit_Item" || !l.ItemType || l.ItemCode);
        const info = {}; try { const cods = [...new Set(L.map((l) => l.ItemCode).filter(Boolean))].slice(0, 40);
          for (const c of cods) { try { const it = await sl.get(`Items('${esc(c)}')?$select=ItemCode,ItemName,ManageBatchNumbers,QuantityOnStock`); info[c] = { nombre: it.ItemName, porLotes: it.ManageBatchNumbers === "tYES", stock: it.QuantityOnStock }; } catch (e) {} } } catch (e) {}
        let padre = {}; try { const it = await sl.get(`Items('${esc(cod)}')?$select=ItemCode,ItemName,ManageBatchNumbers`); padre = { nombre: it.ItemName, porLotes: it.ManageBatchNumbers === "tYES" }; } catch (e) {}
        out.escandallo = { producto: t.TreeCode, nombre: padre.nombre || "", porLotes: !!padre.porLotes, cantidadBase: Number(t.Quantity) || 1, almacen: t.Warehouse || "",
          componentes: L.map((l) => ({ articulo: l.ItemCode, nombre: (info[l.ItemCode] || {}).nombre || "", cantidadBase: Number(l.Quantity) || 0, almacen: l.Warehouse || t.Warehouse || "", porLotes: !!(info[l.ItemCode] || {}).porLotes, stock: (info[l.ItemCode] || {}).stock })) };
        return;
      }
      if (req.method === "GET" && q.almacenes !== undefined) {
        const r = await sl.get("Warehouses?$select=WarehouseCode,WarehouseName,Inactive&$orderby=WarehouseCode");
        out.almacenes = (r.value || []).filter((w) => w.Inactive !== "tYES").map((w) => ({ codigo: w.WarehouseCode, nombre: w.WarehouseName })); return;
      }
      if (req.method === "GET" && q.lotes) {
        const item = String(q.lotes).toUpperCase(), alm = q.almacen ? String(q.almacen).toUpperCase() : "";
        const NOMBRE = "CRM_LotesStock"; let lotes = null;
        try { const r = await sl.get(`SQLQueries('${NOMBRE}')/List?ItemCode='${esc(item)}'`); lotes = r.value || []; } catch (e) { out.avisoSql = String(e.message || e).slice(0, 160); }
        if (lotes) { out.lotes = lotes.map((l) => ({ lote: l.BatchNum, almacen: l.WhsCode, cantidad: Number(l.Quantity) || 0, caducidad: String(l.ExpDate || "").slice(0, 10) || null })).filter((l) => !alm || l.almacen === alm).sort((a, b) => String(a.caducidad || "9").localeCompare(String(b.caducidad || "9"))); return; }
        const r = await sl.get(`BatchNumberDetails?$select=Batch,ItemCode,Status,ExpirationDate,AdmissionDate&$filter=ItemCode eq '${esc(item)}' and Status eq 'bdsStatus_Released'&$orderby=AdmissionDate desc&$top=50`);
        out.lotes = (r.value || []).map((l) => ({ lote: l.Batch, almacen: alm || null, cantidad: null, caducidad: String(l.ExpirationDate || "").slice(0, 10) || null })); out.via = "sin cantidades"; return;
      }
      if (req.method === "GET" && q.orden) {
        const r = await sl.get(`ProductionOrders?$filter=DocumentNumber eq ${Number(q.orden) || 0}`); out.orden = (r.value || [])[0] || null; return;
      }
      if (req.method === "POST") {
        const p = (body && body.parte) || {};
        if (!p.producto) throw new Error("falta el producto"); const cant = Number(p.cantidad); if (!(cant > 0)) throw new Error("cantidad a fabricar no válida");
        if (!p.almacen) throw new Error("falta el almacén"); if (!p.loteNuevo) throw new Error("falta el nº de lote nuevo");
        const C = (Array.isArray(p.componentes) ? p.componentes : []).filter((c) => c && c.articulo && Number(c.uds) > 0);
        if (!C.length) throw new Error("no hay componentes con cantidad");
        const hoy = new Date().toISOString().slice(0, 10), fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(p.fecha || "")) ? p.fecha : hoy;
        for (const c of C) { const lotes = (c.lotes || []).filter((b) => b && b.lote && Number(b.uds) > 0); if (lotes.length) { const s = lotes.reduce((t, b) => t + Number(b.uds), 0); if (Math.abs(s - Number(c.uds)) > 0.0001) throw new Error("en " + c.articulo + " los lotes suman " + s + " y el componente lleva " + c.uds); } }
        // 1) Orden de fabricación liberada con los componentes del parte
        const orden = { ItemNo: String(p.producto), PlannedQuantity: cant, Warehouse: String(p.almacen), PostingDate: fecha, StartDate: fecha, DueDate: fecha,
          ProductionOrderStatus: "boposReleased", ProductionOrderType: "bopotStandard", Remarks: String(p.comentario || "").slice(0, 254) || undefined,
          ProductionOrderLines: C.map((c) => ({ ItemNo: String(c.articulo), PlannedQuantity: Number(c.uds), BaseQuantity: Number(c.uds) / cant, Warehouse: String(c.almacen || p.almacen) })) };
        out.enviado = { orden };
        let o = await sl.post("ProductionOrders", orden);
        if (o.ProductionOrderStatus !== "boposReleased") { try { await sl.patch(`ProductionOrders(${o.AbsoluteEntry})`, { ProductionOrderStatus: "boposReleased" }); o = await sl.get(`ProductionOrders(${o.AbsoluteEntry})`); } catch (e) { out.avisoLiberar = String(e.message || e).slice(0, 200); } }
        out.orden = { AbsoluteEntry: o.AbsoluteEntry, DocumentNumber: o.DocumentNumber, estado: o.ProductionOrderStatus, producto: o.ItemNo, cantidad: o.PlannedQuantity, almacen: o.Warehouse,
          lineas: (o.ProductionOrderLines || []).map((l) => ({ linea: l.LineNumber, articulo: l.ItemNo, planificado: l.PlannedQuantity, almacen: l.Warehouse })) };
        // 2) Salida de componentes (enlazada a la orden, tipo base 202)
        const lineaDe = (art) => { const l = (o.ProductionOrderLines || []).find((x) => String(x.ItemNo).toUpperCase() === String(art).toUpperCase()); return l ? l.LineNumber : null; };
        const salida = { DocDate: fecha, Comments: ("Parte de producción CRM · OF " + o.DocumentNumber).slice(0, 254),
          DocumentLines: C.map((c) => { const ln = lineaDe(c.articulo); const d = { ItemCode: String(c.articulo), Quantity: Number(c.uds), WarehouseCode: String(c.almacen || p.almacen), BaseType: 202, BaseEntry: o.AbsoluteEntry };
            if (ln !== null) d.BaseLine = ln; const lotes = (c.lotes || []).filter((b) => b && b.lote && Number(b.uds) > 0); if (lotes.length) d.BatchNumbers = lotes.map((b) => ({ BatchNumber: String(b.lote), Quantity: Number(b.uds) })); return d; }) };
        out.enviado.salida = salida;
        const sdoc = await sl.post("InventoryGenExits", salida);
        out.salida = { DocEntry: sdoc.DocEntry, DocNum: sdoc.DocNum, lineas: (sdoc.DocumentLines || []).map((l) => ({ articulo: l.ItemCode, uds: l.Quantity, almacen: l.WarehouseCode, lotes: (l.BatchNumbers || []).map((b) => ({ lote: b.BatchNumber, uds: b.Quantity })) })) };
        // 3) Entrada del producto con el lote nuevo (tipo base 202)
        const lote = { BatchNumber: String(p.loteNuevo), Quantity: cant }; if (/^\d{4}-\d{2}-\d{2}$/.test(String(p.caducidad || ""))) lote.ExpiryDate = p.caducidad; if (/^\d{4}-\d{2}-\d{2}$/.test(String(p.fabricacion || ""))) lote.ManufacturingDate = p.fabricacion; else lote.ManufacturingDate = fecha;
        const entrada = { DocDate: fecha, Comments: ("Parte de producción CRM · OF " + o.DocumentNumber).slice(0, 254), DocumentLines: [{ ItemCode: String(p.producto), Quantity: cant, WarehouseCode: String(p.almacen), BaseType: 202, BaseEntry: o.AbsoluteEntry, BatchNumbers: [lote] }] };
        out.enviado.entrada = entrada;
        const edoc = await sl.post("InventoryGenEntries", entrada);
        out.entrada = { DocEntry: edoc.DocEntry, DocNum: edoc.DocNum, lineas: (edoc.DocumentLines || []).map((l) => ({ articulo: l.ItemCode, uds: l.Quantity, almacen: l.WarehouseCode, coste: l.UnitPrice, lotes: (l.BatchNumbers || []).map((b) => ({ lote: b.BatchNumber, uds: b.Quantity, caducidad: b.ExpiryDate, fabricacion: b.ManufacturingDate })) })) };
        // 4) Cerrar la orden si se pide
        if (p.cerrar) { try { await sl.patch(`ProductionOrders(${o.AbsoluteEntry})`, { ProductionOrderStatus: "boposClosed" }); out.orden.estado = "boposClosed"; } catch (e) { out.avisoCerrar = String(e.message || e).slice(0, 200); } }
        out.mensaje = "Orden " + o.DocumentNumber + " · salida " + sdoc.DocNum + " · entrada " + edoc.DocNum + " (" + db + ")";
        return;
      }
      throw new Error("petición no reconocida");
    });
  } catch (e) { out.ok = false; out.error = String(e.message || e).slice(0, 700); }
  out.segundos = Math.round((Date.now() - t0) / 100) / 10;
  return res.status(out.ok ? 200 : 400).json(out);
};
