// api/sap-planificacion.js — Planificación de fabricación desde el CRM sobre SAP Business One (Service Layer)
//
// Misma clave y variables que sap-pedido.js. Todo se lee y se escribe en SAP en directo: lo que se cambie en SAP se ve
// aquí al recargar, y lo que se haga aquí queda en SAP.
//
// Códigos de UC en las líneas del pedido de venta:
//   U_UC_Solicitud: 1 Prod.BazaFresca · 2 Prod.BazaSeca · 3 Prod.Drimano · 4 Planificador · 5 Compras · 6 Prod.Lleida · 7 Prod.Valencia
//   U_UC_SolicitudEstado: 0 No iniciado · 1 En proceso · 2 Gestionado · 3 Planificado · 4 Finalizado
//
// GET  ?pendientes=1                  → líneas abiertas de pedidos de venta, con su solicitud, estado y órdenes de fabricación ligadas
// GET  ?plan=1&desde=&hasta=          → órdenes de fabricación planificadas/liberadas (con pedido de origen)
// GET  ?movimientos=1&dias=7[&almacen=] → entradas, salidas, traslados y solicitudes de traslado de los últimos días
// GET  ?almacenes=1
// POST {accion:"enviar",   entry, linea, tipo, detalle}           → manda la línea a producción/compras (estado 0)
// POST {accion:"estado",   entry, linea, estado, fecha?, detalle?} → cambia el estado de la solicitud (y la fecha de entrega)
// POST {accion:"planificar", fecha, almacen, lineas:[{entry, linea, uds}]} → una orden de fabricación por línea, ligada al pedido; estado 3
// POST {accion:"orden",    entry, que:"liberar"|"cancelar"|"fecha", fecha?} → cambia una orden de fabricación
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

const TIPOS = { "1": "Prod. Baza Fresca", "2": "Prod. Baza Seca", "3": "Prod. Drimano", "4": "Planificador", "5": "Compras", "6": "Prod. Lleida", "7": "Prod. Valencia" };
const ESTADOS = { "0": "No iniciado", "1": "En proceso", "2": "Gestionado", "3": "Planificado", "4": "Finalizado" };
const F = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
const D = (v) => String(v || "").slice(0, 10) || null;
// Marca en los comentarios de la orden para saber de qué pedido y línea viene (por si SAP no guarda el origen)
const marca = (num, linea) => "PV:" + num + "/" + linea;
const leeMarca = (t) => { const m = String(t || "").match(/PV:(\d+)\/(\d+)/); return m ? { num: Number(m[1]), linea: Number(m[2]) } : null; };

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
  // El pase llega en la cabecera (páginas) o en la cookie «sap_pase» que pone /api/sap-token (cualquier navegador)
  const galleta = (String(req.headers.cookie || "").match(/(?:^|;\s*)sap_pase=([^;]+)/) || [])[1] || "";
  let AUT = autorizado(req.headers["x-crm-key"] || q.key || "");
  if (!AUT.ok && galleta) AUT = autorizado(decodeURIComponent(galleta));
  if (!AUT.ok) return res.status(401).json({ ok: false, error: AUT.caducado ? "el pase ha caducado: vuelve a entrar en el portal" : "clave incorrecta" });
  let body = req.body; if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } } body = body || {};
  const db = String(body.db || q.db || env("SAP_DB") || "U_CARO_00"); if (!DB_OK(db)) return res.status(400).json({ ok: false, error: "base de datos no válida" });
  const out = { ok: true, db }; const t0 = Date.now();
  try {
    await conSesion(db, async (sl) => {
      const todas = async (ruta, max = 3000) => { const sep = ruta.includes("?") ? "&" : "?"; let o = [], sk = 0; while (o.length < max) { const r = await sl.get(ruta + sep + "$top=200&$skip=" + sk); const v = r.value || []; o.push(...v); if (v.length < 200) break; sk += 200; } return o; };
      const ordenesAbiertas = async () => { const r = await todas("ProductionOrders?$select=AbsoluteEntry,DocumentNumber,ItemNo,ProductDescription,PlannedQuantity,CompletedQuantity,ProductionOrderStatus,DueDate,StartDate,Warehouse,Remarks,ProductionOrderOriginEntry,ProductionOrderOriginNumber,CustomerCode&$filter=ProductionOrderStatus eq 'boposPlanned' or ProductionOrderStatus eq 'boposReleased'&$orderby=DueDate", 2000).catch(async () => todas("ProductionOrders?$select=AbsoluteEntry,DocumentNumber,ItemNo,ProductDescription,PlannedQuantity,CompletedQuantity,ProductionOrderStatus,DueDate,StartDate,Warehouse,Remarks&$filter=ProductionOrderStatus eq 'boposPlanned' or ProductionOrderStatus eq 'boposReleased'&$orderby=DueDate", 2000));
        return r.map((o) => { const mk = leeMarca(o.Remarks); return { entry: o.AbsoluteEntry, num: o.DocumentNumber, articulo: o.ItemNo, descripcion: o.ProductDescription, uds: o.PlannedQuantity, hechas: o.CompletedQuantity, estado: o.ProductionOrderStatus === "boposReleased" ? "liberada" : "planificada",
          fecha: D(o.DueDate), inicio: D(o.StartDate), almacen: o.Warehouse, cliente: o.CustomerCode || "", pedido: o.ProductionOrderOriginNumber || (mk && mk.num) || null, pedidoEntry: o.ProductionOrderOriginEntry || null, linea: mk ? mk.linea : null, notas: String(o.Remarks || "").replace(/PV:\d+\/\d+\s*·?\s*/, "") }; }); };
      const lineaPedido = async (entry, linea) => { const o = await sl.get(`Orders(${Number(entry)})?$select=DocEntry,DocNum,CardCode,CardName,DocumentStatus,DocumentLines`); const l = (o.DocumentLines || []).find((x) => Number(x.LineNum) === Number(linea)); if (!l) throw new Error("la línea " + linea + " no está en el pedido " + o.DocNum); if (o.DocumentStatus !== "bost_Open" || l.LineStatus === "bost_Close") throw new Error("el pedido " + o.DocNum + " o esa línea ya están cerrados"); return { o, l }; };
      const patchLinea = async (entry, linea, campos) => sl.patch(`Orders(${Number(entry)})`, { DocumentLines: [Object.assign({ LineNum: Number(linea) }, campos)] });

      if (req.method === "GET" && q.almacenes !== undefined) { const r = await sl.get("Warehouses?$select=WarehouseCode,WarehouseName,Inactive&$orderby=WarehouseCode"); out.almacenes = (r.value || []).filter((w) => w.Inactive !== "tYES").map((w) => ({ codigo: w.WarehouseCode, nombre: w.WarehouseName })); return; }

      if (req.method === "GET" && q.pendientes !== undefined) {
        const nombres = {}; try { for (const v of await todas("SalesPersons?$select=SalesEmployeeCode,SalesEmployeeName", 500)) nombres[String(v.SalesEmployeeCode)] = String(v.SalesEmployeeName || "").trim(); } catch (e) {}
        const ped = await todas("Orders?$select=DocEntry,DocNum,DocDate,CardCode,CardName,SalesPersonCode,Confirmed,DocumentLines&$filter=DocumentStatus eq 'bost_Open'&$orderby=DocEntry desc", 1500);
        const ords = await ordenesAbiertas();
        const ligadas = (p, l) => ords.filter((o) => (o.pedidoEntry === p.DocEntry || o.pedido === p.DocNum) && String(o.articulo).toUpperCase() === String(l.ItemCode).toUpperCase() && (o.linea == null || o.linea === l.LineNum));
        out.lineas = [];
        for (const p of ped) for (const l of (p.DocumentLines || [])) { if (l.LineStatus === "bost_Close" || !(Number(l.RemainingOpenQuantity) > 0)) continue;
          const tipo = String(l.U_UC_Solicitud ?? "0"), est = String(l.U_UC_SolicitudEstado ?? "0"); const of = ligadas(p, l);
          out.lineas.push({ entry: p.DocEntry, num: p.DocNum, fecha: D(p.DocDate), cliente: p.CardCode, nombre: p.CardName, vendedor: nombres[String(p.SalesPersonCode)] || "", confirmado: p.Confirmed === "tYES",
            linea: l.LineNum, articulo: l.ItemCode, descripcion: l.ItemDescription, uds: Number(l.RemainingOpenQuantity) || 0, entrega: D(l.ShipDate), almacen: l.WarehouseCode,
            tipo, tipoN: TIPOS[tipo] || (tipo === "0" ? "" : tipo), estado: est, estadoN: ESTADOS[est] || est, detalle: String(l.U_UC_SolicitudDetalle || ""),
            ordenes: of.map((o) => ({ num: o.num, entry: o.entry, fecha: o.fecha, uds: o.uds, estado: o.estado })) }); }
        out.tipos = TIPOS; out.estados = ESTADOS; return;
      }

      if (req.method === "GET" && q.plan !== undefined) {
        const L = await ordenesAbiertas(); const de = F(q.desde) ? q.desde : "0000", ha = F(q.hasta) ? q.hasta : "9999";
        out.ordenes = L.filter((o) => !o.fecha || (o.fecha >= de && o.fecha <= ha)).filter((o) => !q.almacen || o.almacen === String(q.almacen).toUpperCase()); return;
      }

      if (req.method === "GET" && q.movimientos !== undefined) {
        const dias = Math.min(Number(q.dias) || 7, 60); const desde = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10); const alm = q.almacen ? String(q.almacen).toUpperCase() : "";
        const sel = "DocEntry,DocNum,DocDate,Comments,JournalMemo,DocumentLines"; const res2 = [];
        const add = (tipo, docs, lineasDe) => { for (const d of docs) for (const l of lineasDe(d)) { if (alm && l.de !== alm && l.a !== alm && l.alm !== alm) continue; res2.push(Object.assign({ tipo, num: d.DocNum, fecha: D(d.DocDate), nota: String(d.Comments || d.JournalMemo || "").slice(0, 120) }, l)); } };
        const bat = (l) => (l.BatchNumbers || []).map((b) => b.BatchNumber + (b.Quantity !== l.Quantity ? " (" + b.Quantity + ")" : "")).join(", ");
        try { add("entrada", await todas(`InventoryGenEntries?$select=${sel}&$filter=DocDate ge '${desde}'&$orderby=DocEntry desc`, 400), (d) => (d.DocumentLines || []).map((l) => ({ articulo: l.ItemCode, descripcion: l.ItemDescription, uds: l.Quantity, alm: l.WarehouseCode, lotes: bat(l), produccion: Number(l.BaseType) === 202 }))); } catch (e) { out.avisoEntradas = String(e.message).slice(0, 120); }
        try { add("salida", await todas(`InventoryGenExits?$select=${sel}&$filter=DocDate ge '${desde}'&$orderby=DocEntry desc`, 400), (d) => (d.DocumentLines || []).map((l) => ({ articulo: l.ItemCode, descripcion: l.ItemDescription, uds: -Number(l.Quantity), alm: l.WarehouseCode, lotes: bat(l), produccion: Number(l.BaseType) === 202 }))); } catch (e) { out.avisoSalidas = String(e.message).slice(0, 120); }
        try { add("traslado", await todas(`StockTransfers?$select=DocEntry,DocNum,DocDate,Comments,FromWarehouse,ToWarehouse,StockTransferLines&$filter=DocDate ge '${desde}'&$orderby=DocEntry desc`, 400), (d) => (d.StockTransferLines || []).map((l) => ({ articulo: l.ItemCode, descripcion: l.ItemDescription, uds: l.Quantity, de: l.FromWarehouseCode || d.FromWarehouse, a: l.WarehouseCode || d.ToWarehouse, lotes: bat(l) }))); } catch (e) { out.avisoTraslados = String(e.message).slice(0, 120); }
        try { add("solicitud traslado", await todas(`InventoryTransferRequests?$select=DocEntry,DocNum,DocDate,Comments,FromWarehouse,ToWarehouse,DocumentStatus,StockTransferLines&$filter=DocDate ge '${desde}'&$orderby=DocEntry desc`, 400), (d) => (d.StockTransferLines || []).map((l) => ({ articulo: l.ItemCode, descripcion: l.ItemDescription, uds: l.Quantity, de: l.FromWarehouseCode || d.FromWarehouse, a: l.WarehouseCode || d.ToWarehouse, lotes: String(l.FreeText || ""), pendiente: d.DocumentStatus === "bost_Open" && l.LineStatus !== "bost_Close" }))); } catch (e) { out.avisoSolicitudes = String(e.message).slice(0, 120); }
        out.movimientos = res2.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)) || b.num - a.num); out.desde = desde; return;
      }

      if (req.method === "POST" && body.accion === "enviar") {
        const tipo = String(body.tipo || ""); if (!TIPOS[tipo]) throw new Error("elige a quién se manda (producción o compras)");
        if (!String(body.detalle || "").trim()) throw new Error("escribe qué hay que hacer (es obligatorio)");
        await lineaPedido(body.entry, body.linea);
        await patchLinea(body.entry, body.linea, { U_UC_Solicitud: tipo, U_UC_SolicitudEstado: "0", U_UC_SolicitudDetalle: String(body.detalle).slice(0, 250) });
        out.mensaje = "Enviado a " + TIPOS[tipo] + " (No iniciado)"; return;
      }
      if (req.method === "POST" && body.accion === "estado") {
        const est = String(body.estado ?? ""); if (!ESTADOS[est]) throw new Error("estado no válido");
        const { l } = await lineaPedido(body.entry, body.linea);
        if ((est === "2" || est === "3") && !F(body.fecha) && !l.ShipDate) throw new Error("pon la fecha en que estará (es obligatoria)");
        const c = { U_UC_SolicitudEstado: est }; if (F(body.fecha)) c.ShipDate = body.fecha; if (body.detalle) c.U_UC_SolicitudDetalle = String(body.detalle).slice(0, 250);
        await patchLinea(body.entry, body.linea, c); out.mensaje = "Estado: " + ESTADOS[est] + (F(body.fecha) ? " · entrega " + body.fecha : ""); return;
      }
      if (req.method === "POST" && body.accion === "planificar") {
        if (!F(body.fecha)) throw new Error("falta el día de fabricación"); if (!body.almacen) throw new Error("falta el almacén de fabricación");
        const L = (body.lineas || []).filter((x) => x && x.entry && x.linea !== undefined && Number(x.uds) > 0); if (!L.length) throw new Error("elige al menos un pedido con cantidad");
        out.creadas = []; out.errores = [];
        for (const x of L) {
          try { const { o, l } = await lineaPedido(x.entry, x.linea);
            let tieneBom = false; try { await sl.get(`ProductTrees('${esc(l.ItemCode)}')?$select=TreeCode`); tieneBom = true; } catch (e) {}
            if (!tieneBom) throw new Error(l.ItemCode + " no tiene receta (escandallo) en SAP: no se puede planificar");
            const base = { ItemNo: l.ItemCode, PlannedQuantity: Number(x.uds), Warehouse: String(body.almacen).toUpperCase(), PostingDate: body.fecha, StartDate: body.fecha, DueDate: body.fecha, ProductionOrderStatus: "boposPlanned", ProductionOrderType: "bopotStandard",
              Remarks: (marca(o.DocNum, l.LineNum) + " · " + o.CardName + (body.nota ? " · " + body.nota : "")).slice(0, 254) };
            let r; try { r = await sl.post("ProductionOrders", Object.assign({ ProductionOrderOrigin: "bopooSalesOrder", ProductionOrderOriginEntry: o.DocEntry, CustomerCode: o.CardCode }, base)); }
            catch (e) { r = await sl.post("ProductionOrders", base); }   // si SAP no deja fijar el origen, queda ligada por la marca PV: de los comentarios
            await patchLinea(o.DocEntry, l.LineNum, { U_UC_SolicitudEstado: "3" });
            out.creadas.push({ orden: r.DocumentNumber, entry: r.AbsoluteEntry, pedido: o.DocNum, articulo: l.ItemCode, uds: Number(x.uds) }); }
          catch (e) { out.errores.push({ entry: x.entry, linea: x.linea, error: String(e.message || e).slice(0, 220) }); }
        }
        out.ok = !out.errores.length || out.creadas.length > 0; out.mensaje = out.creadas.length + " orden(es) creada(s)" + (out.errores.length ? " · " + out.errores.length + " con error" : ""); return;
      }
      if (req.method === "POST" && body.accion === "orden") {
        const e = Number(body.entry); if (!(e > 0)) throw new Error("falta la orden");
        if (body.que === "liberar") await sl.patch(`ProductionOrders(${e})`, { ProductionOrderStatus: "boposReleased" });
        else if (body.que === "cancelar") { if (!String(body.motivo || "").trim()) throw new Error("escribe el motivo de la cancelación (es obligatorio)"); await sl.post(`ProductionOrders(${e})/Cancel`, {}); }
        else if (body.que === "fecha") { if (!F(body.fecha)) throw new Error("falta la fecha"); await sl.patch(`ProductionOrders(${e})`, { DueDate: body.fecha, StartDate: body.fecha }); }
        else throw new Error("acción no válida");
        out.mensaje = "Orden actualizada"; return;
      }
      throw new Error("petición no reconocida");
    });
  } catch (e) { out.ok = false; out.error = String(e.message || e).slice(0, 600); }
  out.segundos = Math.round((Date.now() - t0) / 100) / 10;
  return res.status(out.ok ? 200 : 400).json(out);
};
