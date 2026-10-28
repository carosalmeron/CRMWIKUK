// api/sap-factura.js — Alta de FACTURAS de venta (autoventa) en SAP Business One (Service Layer), con lotes
//
// Variables en Vercel (las mismas que sap-test.js): SAP_URL, SAP_DB, SAP_USER, SAP_PASS, SAP_INSECURE / SAP_CA
//   + SAP_PEDIDOS_KEY  clave que debe mandar la página (cabecera x-crm-key). Si no existe, se admite CRON_SECRET.
//
// GET  ?clientes=texto · ?articulos=texto · ?precio=ITEM&cliente=CARDCODE   (igual que sap-pedido.js)
// GET  ?almacenes=1                   → almacenes activos (código y nombre)
// GET  ?lotes=ITEM[&almacen=WHS]       → lotes con existencias de ese artículo (lote, almacén, cantidad, caducidad)
// GET  ?factura=DOCNUM                 → consulta una factura creada
// POST { db?, factura:{ cliente, fecha?, vencimiento?, comentario?, vendedor?, almacen?, lineas:[{ articulo, uds, precio?, almacen?, lotes:[{lote, uds}] }] } }
//      → crea la factura de venta (Invoices) con sus lotes y devuelve nº, total y líneas.
//      db = "U_CARO_99" para probar contra la base de pruebas (por defecto, SAP_DB).
//
// Los lotes se leen con una consulta guardada en SAP (SQLQueries «CRM_LotesStock» sobre OIBT); si el usuario no puede
// crearla, se usa BatchNumberDetails (lista de lotes sin cantidades) y SAP valida la cantidad al facturar.
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
  const post = async (ruta, body) => { const r = await pedir(base, ruta, { method: "POST", body, cookies, ca, insecure }); if (r.status >= 300) throw new Error("SAP no ha aceptado el pedido (" + r.status + "): " + msgDe(r)); return r.json; };
  try { return await fn({ get, post }); }
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
      if (req.method === "GET" && q.clientes !== undefined) {
        const t = esc(String(q.clientes || "").trim()); if (t.length < 2) { out.clientes = []; return; }
        const r = await sl.get(`BusinessPartners?$select=CardCode,CardName,FederalTaxID,SalesPersonCode,PriceListNum,PayTermsGrpCode,Frozen,Valid&$filter=CardType eq 'cCustomer' and (contains(CardName,'${t}') or contains(CardCode,'${t}') or contains(FederalTaxID,'${t}'))&$orderby=CardName&$top=15`);
        out.clientes = (r.value || []).map((c) => ({ codigo: c.CardCode, nombre: c.CardName, cif: c.FederalTaxID, vendedor: c.SalesPersonCode, listaPrecios: c.PriceListNum, bloqueado: c.Frozen === "tYES" || c.Valid === "tNO" }));
        return;
      }
      if (req.method === "GET" && q.articulos !== undefined) {
        const t = esc(String(q.articulos || "").trim().toUpperCase()); if (t.length < 2) { out.articulos = []; return; }
        const r = await sl.get(`Items?$select=ItemCode,ItemName,QuantityOnStock,QuantityOrderedByCustomers,SalesQtyPerPackUnit,U_SCL_CALIBRE,U_SCL_Metraje,ManageBatchNumbers,SalesItem,Valid&$filter=SalesItem eq 'tYES' and Valid eq 'tYES' and (startswith(ItemCode,'${t}') or contains(ItemName,'${t}'))&$orderby=ItemCode&$top=25`);
        out.articulos = (r.value || []).map((i) => ({ codigo: i.ItemCode, nombre: i.ItemName, stock: i.QuantityOnStock, libre: (Number(i.QuantityOnStock) || 0) - (Number(i.QuantityOrderedByCustomers) || 0), udsPaquete: i.SalesQtyPerPackUnit, calibre: i.U_SCL_CALIBRE, metros: i.U_SCL_Metraje, porLotes: i.ManageBatchNumbers === "tYES" }));
        return;
      }
      if (req.method === "GET" && q.precio) {
        let lista = null; if (q.cliente) { try { const c = await sl.get(`BusinessPartners('${esc(q.cliente)}')?$select=PriceListNum`); lista = c.PriceListNum; } catch (e) {} }
        const it = await sl.get(`Items('${esc(q.precio)}')?$select=ItemCode,ItemPrices`);
        const P = it.ItemPrices || []; const p = lista != null ? P.find((x) => Number(x.PriceList) === Number(lista)) : null;
        out.precio = p ? p.Price : null; out.listaPrecios = lista; return;
      }
      if (req.method === "GET" && q.almacenes !== undefined) {   // lista de almacenes (código y nombre) para elegir el de salida
        const r = await sl.get("Warehouses?$select=WarehouseCode,WarehouseName,Inactive&$orderby=WarehouseCode");
        out.almacenes = (r.value || []).filter((w) => w.Inactive !== "tYES").map((w) => ({ codigo: w.WarehouseCode, nombre: w.WarehouseName })); return;
      }
      if (req.method === "GET" && q.lotes) {
        const item = String(q.lotes).toUpperCase(), alm = q.almacen ? String(q.almacen).toUpperCase() : "";
        // 1) Consulta guardada sobre OIBT (cantidad por lote y almacén). Se crea la primera vez.
        const NOMBRE = "CRM_LotesStock"; let lotes = null, via = "";
        const sqls = [`SELECT T0."ItemCode", T0."BatchNum", T0."WhsCode", T0."Quantity", T0."ExpDate", T0."InDate" FROM OIBT T0 WHERE T0."ItemCode" = :ItemCode AND T0."Quantity" > 0`,
                      `SELECT T0.ItemCode, T0.BatchNum, T0.WhsCode, T0.Quantity, T0.ExpDate, T0.InDate FROM OIBT T0 WHERE T0.ItemCode = :ItemCode AND T0.Quantity > 0`];
        for (let intento = 0; intento < 2 && !lotes; intento++) {
          try { const r = await sl.get(`SQLQueries('${NOMBRE}')/List?ItemCode='${esc(item)}'`); lotes = r.value || []; via = "sqlquery"; }
          catch (e) { if (intento === 0) { try { await sl.post("SQLQueries", { SqlCode: NOMBRE, SqlName: "Lotes con stock por almacén (CRM)", SqlText: sqls[0] }); } catch (e2) { try { await sl.post("SQLQueries", { SqlCode: NOMBRE, SqlName: "Lotes con stock por almacén (CRM)", SqlText: sqls[1] }); } catch (e3) { out.avisoSql = String(e3.message || e3).slice(0, 200); } } } }
        }
        if (lotes) { out.lotes = lotes.map((l) => ({ lote: l.BatchNum, almacen: l.WhsCode, cantidad: Number(l.Quantity) || 0, caducidad: String(l.ExpDate || "").slice(0, 10) || null, entrada: String(l.InDate || "").slice(0, 10) || null })).filter((l) => !alm || l.almacen === alm).sort((a, b) => String(a.caducidad || "9").localeCompare(String(b.caducidad || "9"))); out.via = via; return; }
        // 2) Sin consulta guardada: lista de lotes (sin cantidades); SAP validará la cantidad al facturar
        const r = await sl.get(`BatchNumberDetails?$select=Batch,ItemCode,Status,ExpirationDate,AdmissionDate&$filter=ItemCode eq '${esc(item)}' and Status eq 'bdsStatus_Released'&$orderby=AdmissionDate desc&$top=50`);
        out.lotes = (r.value || []).map((l) => ({ lote: l.Batch, almacen: alm || null, cantidad: null, caducidad: String(l.ExpirationDate || "").slice(0, 10) || null, entrada: String(l.AdmissionDate || "").slice(0, 10) || null })); out.via = "batchnumberdetails (sin cantidades)";
        return;
      }
      if (req.method === "GET" && q.factura) {
        const r = await sl.get(`Invoices?$select=DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal,VatSum,DocumentStatus,PaidToDate,DocumentLines&$filter=DocNum eq ${Number(q.factura) || 0}`);
        out.factura = (r.value || [])[0] || null; return;
      }
      if (req.method === "POST") {
        const p = (body && body.factura) || {};
        if (!p.cliente) throw new Error("falta el cliente");
        const L = Array.isArray(p.lineas) ? p.lineas.filter((l) => l && l.articulo && Number(l.uds) > 0) : [];
        if (!L.length) throw new Error("la factura no tiene líneas con artículo y unidades");
        const hoy = new Date().toISOString().slice(0, 10);
        const doc = { CardCode: String(p.cliente), DocDate: /^\d{4}-\d{2}-\d{2}$/.test(String(p.fecha || "")) ? p.fecha : hoy,
          Comments: String(p.comentario || "").slice(0, 254) || undefined,
          DocumentLines: L.map((l) => { const o = { ItemCode: String(l.articulo), Quantity: Number(l.uds) };
            if (l.precio !== undefined && l.precio !== null && l.precio !== "" && isFinite(Number(l.precio))) o.UnitPrice = Number(l.precio);
            const alm = l.almacen || p.almacen; if (alm) o.WarehouseCode = String(alm);
            const lotes = (Array.isArray(l.lotes) ? l.lotes : []).filter((b) => b && b.lote && Number(b.uds) > 0);
            if (lotes.length) { o.BatchNumbers = lotes.map((b) => ({ BatchNumber: String(b.lote), Quantity: Number(b.uds) })); const sum = lotes.reduce((t, b) => t + Number(b.uds), 0); if (Math.abs(sum - Number(l.uds)) > 0.0001) throw new Error("en " + l.articulo + " los lotes suman " + sum + " y la línea tiene " + l.uds + " uds"); }
            return o; }) };
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(p.vencimiento || ""))) doc.DocDueDate = p.vencimiento;
        if (p.vendedor !== undefined && p.vendedor !== "" && isFinite(Number(p.vendedor))) doc.SalesPersonCode = Number(p.vendedor);
        if (p.refCliente) doc.NumAtCard = String(p.refCliente).slice(0, 100);
        out.enviado = doc;
        const r = await sl.post("Invoices", doc);
        out.creado = { DocEntry: r.DocEntry, DocNum: r.DocNum, DocTotal: r.DocTotal, VatSum: r.VatSum, DocDate: r.DocDate, DocDueDate: r.DocDueDate, CardName: r.CardName, DocumentStatus: r.DocumentStatus,
          lineas: (r.DocumentLines || []).map((l) => ({ articulo: l.ItemCode, descripcion: l.ItemDescription, uds: l.Quantity, precio: l.Price, importe: l.LineTotal, almacen: l.WarehouseCode, lotes: (l.BatchNumbers || []).map((b) => ({ lote: b.BatchNumber, uds: b.Quantity })) })) };
        out.mensaje = "Factura " + r.DocNum + " creada en SAP (" + db + ")";
        return;
      }
      throw new Error("petición no reconocida");
    });
  } catch (e) { out.ok = false; out.error = String(e.message || e).slice(0, 600); }
  out.segundos = Math.round((Date.now() - t0) / 100) / 10;
  return res.status(out.ok ? 200 : 400).json(out);
};
