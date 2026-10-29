// api/sap-cs.js — Panel de Customer Service: pedidos de UC con su disponibilidad, y cambios de estado escritos en SAP.
//
// Misma autorización que el resto (pase del portal o SAP_PEDIDOS_KEY).
// GET  ?campos=1                → diagnóstico: valores de los campos U_ de cabecera en los pedidos abiertos
// GET  ?pedidos=1[&dias=60]  → pedidos abiertos con líneas, stock disponible por línea, próxima llegada y estado del flujo
// POST {accion:"validar", entry}                          → pedido confirmado (pasa al almacén). No deja si hay líneas esperando a producción/compras
// POST {accion:"solicitud", entry, linea, tipo, detalle}  → manda la línea a producción (1,2,3,6,7) o compras (5); detalle obligatorio
// POST {accion:"fecha", entry, linea?, fecha, motivo?}    → cambia la fecha de servicio de una línea (o de todas si no se indica)
// Producción/compras: GET ?pedidos=1&solo=prod (más rápido) · GET ?almacenes=1
// POST {accion:"en_proceso"|"confirmar"(fecha)|"devolver"(motivo)|"compra_hecha"|"ordenar"(fecha, almacen, uds), entry, linea}
// POST {accion:"anular_solicitud", entry, linea}          → quita la solicitud de una línea (vuelve a Customer Service)
const https = require("https");
const { URL } = require("url");
const env = (k) => { const v = process.env[k]; return v === undefined ? undefined : String(v).trim(); };

function pedir(base, ruta, { method = "GET", body, cookies = "", ca, insecure } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(ruta, base); const datos = body ? JSON.stringify(body) : null;
    const opts = { method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      headers: { "Content-Type": "application/json", Accept: "application/json", Prefer: "odata.maxpagesize=200", ...(cookies ? { Cookie: cookies } : {}), ...(datos ? { "Content-Length": Buffer.byteLength(datos) } : {}) },
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
const Y = (v) => String(v || "").toUpperCase() === "Y" || String(v || "") === "tYES";
// Una línea está SERVIDA solo si SAP la ha copiado a una entrega (15) o factura (13). Cerrar a mano no es servir.
const conEntrega = (l) => { const t = l.TargetType; if (t === undefined || t === null) return (Number(l.Quantity) || 0) - (Number(l.RemainingOpenQuantity) || 0) > 0; return [15, 13].includes(Number(t)); };
const udsServidas = (l) => conEntrega(l) ? Math.max(0, (Number(l.Quantity) || 0) - (Number(l.RemainingOpenQuantity) || 0)) || (l.LineStatus === "bost_Close" ? Number(l.Quantity) || 0 : 0) : 0;
const r3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;

// Acepta la clave SAP_PEDIDOS_KEY o el pase firmado que da /api/sap-token al entrar en el portal (30 días)
function autorizado(dada) {
  const clave = env("SAP_PEDIDOS_KEY") || env("CRON_SECRET"); if (!clave) return { ok: true };
  if (dada === clave) return { ok: true, quien: "clave" };
  const m = String(dada || "").match(/^crm\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/); if (!m) return { ok: false };
  const h = require("crypto").createHmac("sha256", clave).update(m[1]).digest("base64url"); if (h !== m[2]) return { ok: false };
  try { const p = JSON.parse(Buffer.from(m[1], "base64url").toString()); if (!(p.exp > Date.now())) return { ok: false, caducado: true }; return { ok: true, quien: p.n || p.u }; } catch (e) { return { ok: false }; }
}
// Pase de solo lectura (resto de usuarios): firmado con la clave + "|cs-ver"
function soloVer(dada) {
  const clave = env("SAP_PEDIDOS_KEY") || env("CRON_SECRET"); if (!clave) return { ok: false };
  const m = String(dada || "").match(/^crm\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/); if (!m) return { ok: false };
  if (require("crypto").createHmac("sha256", clave + "|cs-ver").update(m[1]).digest("base64url") !== m[2]) return { ok: false };
  try { const p = JSON.parse(Buffer.from(m[1], "base64url").toString()); if (!(p.exp > Date.now())) return { ok: false, caducado: true }; return { ok: true, quien: p.n || p.u, soloVer: true }; } catch (e) { return { ok: false }; }
}
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-crm-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  const q = req.query || {};
  const galleta = (String(req.headers.cookie || "").match(/(?:^|;\s*)sap_pase=([^;]+)/) || [])[1] || "";
  let AUT = autorizado(req.headers["x-crm-key"] || q.key || "");
  if (!AUT.ok && galleta) AUT = autorizado(decodeURIComponent(galleta));
  if (!AUT.ok) { const g2 = (String(req.headers.cookie || "").match(/(?:^|;\s*)cs_pase=([^;]+)/) || [])[1] || ""; for (const t of [req.headers["x-crm-key"] || q.key || "", decodeURIComponent(g2)]) { const v = soloVer(t); if (v.ok) { AUT = v; break; } } }
  // (29/10/2026) Por decisión del CEO: cualquier usuario del portal puede hacer cambios desde este panel.
  // Para volver a solo consulta, pon la variable CS_SOLO_VER=si en Vercel.
  if (AUT.soloVer && req.method === "POST" && env("CS_SOLO_VER") === "si") return res.status(403).json({ ok: false, error: "puedes ver el panel, pero ahora mismo los cambios están desactivados" });
  if (!AUT.ok) return res.status(401).json({ ok: false, error: AUT.caducado ? "el pase ha caducado: vuelve a entrar en el portal" : "clave incorrecta" });
  let body = req.body; if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } } body = body || {};
  const db = String(body.db || q.db || env("SAP_DB") || "U_CARO_00"); if (!DB_OK(db)) return res.status(400).json({ ok: false, error: "base de datos no válida" });
  const out = { ok: true, db, quien: AUT.quien || "", puedeEscribir: !(AUT.soloVer && env("CS_SOLO_VER") === "si") }; const t0 = Date.now();
  try {
    await conSesion(db, async (sl) => {
      const todas = async (ruta, max = 3000) => { let o = [], r = await sl.get(ruta); for (;;) { o.push(...(r.value || [])); const sig = r["odata.nextLink"] || r["@odata.nextLink"]; if (!sig || o.length >= max) break; r = await sl.get(String(sig).replace(/^.*\/b1s\/v\d\//, "")); } return o; };
      const pedido = async (entry) => { const o = await sl.get(`Orders(${Number(entry)})?$select=DocEntry,DocNum,CardName,DocumentStatus,Confirmed,DocumentLines`); if (o.DocumentStatus !== "bost_Open") throw new Error("el pedido " + o.DocNum + " ya está cerrado"); return o; };

      // Diagnóstico: qué valores tienen los campos propios (U_) de cabecera en los pedidos abiertos
      // Diagnóstico de un pedido: GET ?orden=260002906 → estado y a qué documentos se copió cada línea
      if (req.method === "GET" && q.orden) {
        const r = await sl.get(`Orders?$filter=DocNum eq ${Number(q.orden)}&$top=1`); const o = (r.value || [])[0]; if (!o) throw new Error("no encuentro el pedido " + q.orden);
        out.pedido = { num: o.DocNum, estado: o.DocumentStatus, cancelado: o.Cancelled, cierre: o.ClosingDate, actualizado: o.UpdateDate, confirmado: o.Confirmed };
        out.lineas = (o.DocumentLines || []).map((l) => Object.fromEntries(Object.entries(l).filter(([k]) => /^(LineNum|ItemCode|Quantity|RemainingOpenQuantity|OpenAmount|LineStatus|DeliveredQuantity|Target|Base|Shipped|Delivered)/i.test(k))));
        const ents = [];
        for (const ent of ["DeliveryNotes", "Invoices"]) { try { for (const d of await todas(`${ent}?$select=DocNum,DocDate,DocumentLines&$filter=DocDate ge '${String(o.DocDate).slice(0, 10)}' and CardCode eq '${esc(o.CardCode)}'`, 500)) for (const l of (d.DocumentLines || [])) if (Number(l.BaseType) === 17 && Number(l.BaseEntry) === Number(o.DocEntry)) ents.push({ doc: ent + " " + d.DocNum, fecha: D(d.DocDate), linea: l.BaseLine, uds: l.Quantity }); } catch (e) { ents.push({ error: ent + ": " + String(e.message).slice(0, 100) }); } }
        out.entregas = ents; out.servido = ents.some((x) => x.uds > 0); return;
      }
      if (req.method === "GET" && q.campos !== undefined) {
        const uno = await sl.get("Orders?$filter=DocumentStatus eq 'bost_Open'&$orderby=DocEntry desc&$top=1");
        const ej = (uno.value || [])[0] || {};
        const campos = Object.keys(ej).filter((k) => /^U_/.test(k) && !Array.isArray(ej[k]));
        const todos = await todas(`Orders?$select=DocEntry,DocNum,Confirmed,${campos.join(",")}&$filter=DocumentStatus eq 'bost_Open'`, 1500);
        const reparto = {}; for (const k of ["Confirmed", ...campos]) { const c = {}; for (const p of todos) { const v = p[k] === null || p[k] === undefined || p[k] === "" ? "(vacío)" : String(p[k]).slice(0, 30); c[v] = (c[v] || 0) + 1; } if (Object.keys(c).length <= 12 || /Invalid|Valid|Riesg|Cobro|Precio|Bloq/i.test(k)) reparto[k] = c; }
        const cruce = {}; for (const p of todos) { const b = (i, f) => (p[i] === "Y" && p[f] !== "Y") ? "BLOQ" : "ok"; const k = "riesgo " + b("U_SCL_InvalidadoxRiesg", "U_SCL_ValidadoFijoRiesgo") + " · precio " + b("U_SCL_InvalidadoxPrecios", "U_SCL_ValidadoFijoPrecios") + " · cobros " + b("U_SCL_InvalidadoxCobros", "U_SCL_ValidadoFijoCobros") + " · confirmado=" + p.Confirmed; cruce[k] = (cruce[k] || 0) + 1; }
        out.pedidosAbiertos = todos.length; out.reparto = reparto; out.combinaciones = cruce;
        out.ejemplo = Object.fromEntries(Object.entries(ej).filter(([k]) => /Invalid|Valid|Riesg|Cobro|Precio|Bloq|Confirm|Status|Approv|Autor/i.test(k)));
        return;
      }
      if (req.method === "GET" && q.pedidos !== undefined) {
        const T = {}, mide = async (k, f) => { const t = Date.now(); try { return await f(); } finally { T[k] = Math.round((Date.now() - t) / 100) / 10; } };
        // Todo lo que no depende de los pedidos va EN PARALELO (comerciales, compras, fabricación, servidos)
        const nombres = {}; const lleg = {}; const addL = (it, o) => { (lleg[it] = lleg[it] || []).push(o); };
        const ENT = {}; let entregasOk = true;
        let cerr = []; const diasS = Math.min(60, Math.max(1, Number(q.dias) || 15)), desdeS = new Date(Date.now() - diasS * 864e5).toISOString().slice(0, 10);
        const paralelo = Promise.all([
          mide("comerciales", async () => { try { for (const v of await todas("SalesPersons?$select=SalesEmployeeCode,SalesEmployeeName", 500)) nombres[String(v.SalesEmployeeCode)] = String(v.SalesEmployeeName || "").trim(); } catch (e) {} }),
          mide("compras", async () => { try { for (const p of await todas("PurchaseOrders?$select=DocNum,DocDueDate,DocumentLines&$filter=DocumentStatus eq 'bost_Open'", 2000)) for (const l of (p.DocumentLines || [])) { const u = Number(l.RemainingOpenQuantity) || 0; if (u > 0 && l.LineStatus !== "bost_Close") addL(l.ItemCode, { fecha: D(l.ShipDate || p.DocDueDate), uds: u, de: "compra " + p.DocNum, alm: l.WarehouseCode }); } } catch (e) { out.avisoCompras = String(e.message).slice(0, 120); } }),
          mide("fabricacion", async () => { try { for (const o of await todas("ProductionOrders?$select=DocumentNumber,ItemNo,PlannedQuantity,CompletedQuantity,DueDate,Warehouse,ProductionOrderStatus&$filter=ProductionOrderStatus eq 'boposPlanned' or ProductionOrderStatus eq 'boposReleased'", 2000)) { const u = (Number(o.PlannedQuantity) || 0) - (Number(o.CompletedQuantity) || 0); if (u > 0) addL(o.ItemNo, { fecha: D(o.DueDate), uds: u, de: "fabricación " + o.DocumentNumber, alm: o.Warehouse }); } } catch (e) {} }),
          // Entregas y facturas hechas desde pedidos (BaseType 17): lo único que cuenta como SERVIDO
          mide("entregas", async () => { if (q.solo === "prod") return; const desdeE = new Date(Date.now() - (diasS + 10) * 864e5).toISOString().slice(0, 10);
            for (const [ent, tipo] of [["DeliveryNotes", "entrega"], ["Invoices", "factura"]]) { try {
              for (const d of await todas(`${ent}?$select=DocEntry,DocNum,DocDate,Cancelled,DocumentLines&$filter=DocDate ge '${desdeE}' and Cancelled eq 'tNO'`, 4000))
                for (const l of (d.DocumentLines || [])) if (Number(l.BaseType) === 17 && l.BaseEntry) { const k = l.BaseEntry + "|" + l.BaseLine, e = ENT[k] = ENT[k] || { uds: 0, fecha: "", docs: [] }; e.uds += Number(l.Quantity) || 0; if (String(d.DocDate) > e.fecha) e.fecha = D(d.DocDate); e.docs.push(tipo + " " + d.DocNum); }
            } catch (e) { entregasOk = false; out.avisoEntregas = (out.avisoEntregas || "") + ent + ": " + String(e.message).slice(0, 120) + " "; } } }),
          mide("servidos", async () => { if (q.solo === "prod") return; try { cerr = await todas(`Orders?$select=DocEntry,DocNum,DocDate,DocDueDate,ClosingDate,UpdateDate,CardCode,CardName,SalesPersonCode,DocTotal,U_SCL_FechaAgente,DocumentLines&$filter=DocumentStatus eq 'bost_Close' and Cancelled eq 'tNO' and UpdateDate ge '${desdeS}'&$orderby=DocEntry desc`, 1500); } catch (e) { try { cerr = await todas(`Orders?$select=DocEntry,DocNum,DocDate,DocDueDate,UpdateDate,CardCode,CardName,SalesPersonCode,DocTotal,DocumentLines&$filter=DocumentStatus eq 'bost_Close' and Cancelled eq 'tNO' and UpdateDate ge '${desdeS}'&$orderby=DocEntry desc`, 1500); } catch (e2) { out.avisoServidos = String(e2.message).slice(0, 160); } } }),
        ]);
        const sel = "DocEntry,DocNum,DocDate,DocDueDate,UpdateDate,CardCode,CardName,SalesPersonCode,Confirmed,Comments,DocTotal,U_SCL_InvalidadoxPrecios,U_SCL_InvalidadoxCobros,U_SCL_InvalidadoxRiesg,U_SCL_InvalidadoxMuestras,U_SCL_ValidadoFijoPrecios,U_SCL_ValidadoFijoCobros,U_SCL_ValidadoFijoRiesgo,U_SCL_ValidadoFijoMuestra,U_SCL_FechaAgente,DocumentLines";
        const ped = await mide("pedidos", () => todas(`Orders?$select=${sel}&$filter=DocumentStatus eq 'bost_Open'&$orderby=DocEntry desc`, 1500));
        const stock = {};
        await mide("stock", async () => {
        // Stock por artículo y almacén (libre = en stock − comprometido)
        const items = [...new Set(ped.flatMap((p) => (p.DocumentLines || []).filter((l) => l.LineStatus !== "bost_Close").map((l) => String(l.ItemCode))))].filter(Boolean);
        const trozos = []; for (let i = 0; i < items.length; i += 40) trozos.push(items.slice(i, i + 40));
        for (let i = 0; i < trozos.length; i += 8) await Promise.all(trozos.slice(i, i + 8).map(async (tz) => { try {
          const r = await sl.get(`Items?$select=ItemCode,InventoryUOM,SalesUnit,ItemWarehouseInfoCollection&$filter=${encodeURIComponent(tz.map((c) => `ItemCode eq '${esc(c)}'`).join(" or "))}&$top=100`);
          for (const it of (r.value || [])) { const w = {}; for (const x of (it.ItemWarehouseInfoCollection || [])) w[x.WarehouseCode] = { stock: Number(x.InStock) || 0, comp: Number(x.Committed) || 0 }; stock[it.ItemCode] = { w, ud: it.SalesUnit || it.InventoryUOM || "" }; } } catch (e) {} }));
        });
        await paralelo; out.tiempos = T;
        for (const k of Object.keys(lleg)) lleg[k].sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
        const hoy = new Date().toISOString().slice(0, 10);
        out.pedidos = ped.map((p) => {
          const L = (p.DocumentLines || []).filter((l) => l.LineStatus !== "bost_Close" && (Number(l.RemainingOpenQuantity) || 0) > 0).map((l) => {
            const pend = Number(l.RemainingOpenQuantity) || 0, alm = l.WarehouseCode || "", s = stock[l.ItemCode] || { w: {} }, w = s.w[alm] || { stock: 0, comp: 0 };
            // Libre para ESTE pedido: el comprometido de SAP ya incluye esta línea
            const libre = r3(w.stock - (w.comp - pend));
            const otros = Object.entries(s.w).filter(([k, v]) => k !== alm && v.stock - v.comp > 0).map(([k, v]) => ({ alm: k, libre: r3(v.stock - v.comp) })).sort((a, b) => b.libre - a.libre).slice(0, 3);
            const tipo = String(l.U_UC_Solicitud ?? "0"), est = String(l.U_UC_SolicitudEstado ?? "0"), conSol = !!TIPOS[tipo];
            return { linea: l.LineNum, articulo: l.ItemCode, descripcion: l.ItemDescription, pide: r3(pend), ud: s.ud || l.MeasureUnit || "", alm, stock: r3(w.stock), libre, hay: libre >= pend,
              otros, llegadas: (lleg[l.ItemCode] || []).filter((x) => !x.fecha || x.fecha >= hoy).slice(0, 3), entrega: D(l.ShipDate), precio: Number(l.Price) || 0, importe: Number(l.LineTotal) || 0,
              sol: conSol ? { tipo, quien: TIPOS[tipo], estado: est, estadoN: ESTADOS[est] || est, detalle: String(l.U_UC_SolicitudDetalle || ""), pendiente: est === "0" || est === "1" } : null };
          });
          const conf = Y(p.Confirmed), esperando = L.some((l) => l.sol && l.sol.pendiente), resueltas = L.some((l) => l.sol && !l.sol.pendiente);
          const etapa = conf ? "validado" : esperando ? "esperando" : resueltas ? "reconfirmar" : "nuevo";
          return { entry: p.DocEntry, num: p.DocNum, fecha: D(p.DocDate), entrega: D(p.DocDueDate), pideComercial: D(p.U_SCL_FechaAgente), actualizado: D(p.UpdateDate), cliente: p.CardCode, nombre: p.CardName,
            vendedor: nombres[String(p.SalesPersonCode)] || "", total: Number(p.DocTotal) || 0, comentario: String(p.Comments || "").slice(0, 200), confirmado: conf,
            // Bloqueado = invalidado y nadie lo ha validado (ValidadoFijo = N)
            precios: Y(p.U_SCL_InvalidadoxPrecios) && !Y(p.U_SCL_ValidadoFijoPrecios), cobros: Y(p.U_SCL_InvalidadoxCobros) && !Y(p.U_SCL_ValidadoFijoCobros), riesgo: Y(p.U_SCL_InvalidadoxRiesg) && !Y(p.U_SCL_ValidadoFijoRiesgo), muestras: Y(p.U_SCL_InvalidadoxMuestras) && !Y(p.U_SCL_ValidadoFijoMuestra), etapa, todoStock: L.length > 0 && L.every((l) => l.hay || (l.sol && !l.sol.pendiente)), lineas: L };
        }).filter((p) => p.lineas.length);
        for (const p of out.pedidos) { const o = ped.find((x) => x.DocEntry === p.entry); p.servidoParcial = (o.DocumentLines || []).filter((l) => (Number(l.Quantity) || 0) - (Number(l.RemainingOpenQuantity) || 0) > 0 && (l.LineStatus !== "bost_Close" || ENT[o.DocEntry + "|" + l.LineNum])).length; }
        for (const p of cerr) {
          let ultima = "";
          const L = (p.DocumentLines || []).map((l) => {
            const e = ENT[p.DocEntry + "|" + l.LineNum]; const uds = entregasOk ? (e ? e.uds : 0) : udsServidas(l); if (e && e.fecha > ultima) ultima = e.fecha;
            return { linea: l.LineNum, articulo: l.ItemCode, descripcion: l.ItemDescription, pide: r3(l.Quantity), servido: r3(Math.min(uds, Number(l.Quantity) || uds)), conEntrega: uds > 0, docs: e ? [...new Set(e.docs)].slice(0, 3) : [], ud: l.MeasureUnit || "", alm: l.WarehouseCode || "", entrega: D(l.ShipDate), importe: Number(l.LineTotal) || 0, hay: true, llegadas: [], otros: [], sol: null };
          });
          const algo = L.some((l) => l.conEntrega);
          out.pedidos.push({ entry: p.DocEntry, num: p.DocNum, fecha: D(p.DocDate), entrega: D(p.DocDueDate), pideComercial: D(p.U_SCL_FechaAgente), servidoEl: (algo && ultima) || D(p.ClosingDate || p.UpdateDate), cliente: p.CardCode, nombre: p.CardName,
            vendedor: nombres[String(p.SalesPersonCode)] || "", total: Number(p.DocTotal) || 0, comentario: "", confirmado: true, etapa: algo ? "servido" : "anulado", lineas: L });
        }
        out.tipos = TIPOS; return;
      }
      if (req.method === "POST" && body.accion === "validar") {
        const o = await pedido(body.entry);
        const esp = (o.DocumentLines || []).filter((l) => l.LineStatus !== "bost_Close" && TIPOS[String(l.U_UC_Solicitud ?? "0")] && ["0", "1"].includes(String(l.U_UC_SolicitudEstado ?? "0")));
        if (esp.length) throw new Error("no se puede validar: " + esp.length + " línea(s) siguen esperando respuesta de producción/compras (" + esp.map((l) => l.ItemCode).join(", ") + ")");
        await sl.patch(`Orders(${o.DocEntry})`, { Confirmed: "tYES" });
        out.mensaje = "Pedido " + o.DocNum + " validado: pasa al almacén"; return;
      }
      if (req.method === "POST" && body.accion === "solicitud") {
        const tipo = String(body.tipo || ""); if (!TIPOS[tipo]) throw new Error("elige a quién se manda");
        if (String(body.detalle || "").trim().length < 3) throw new Error("escribe qué pasa (es obligatorio)");
        const o = await pedido(body.entry); const l = (o.DocumentLines || []).find((x) => Number(x.LineNum) === Number(body.linea)); if (!l) throw new Error("línea no encontrada");
        await sl.patch(`Orders(${o.DocEntry})`, { Confirmed: "tNO", DocumentLines: [{ LineNum: l.LineNum, U_UC_Solicitud: tipo, U_UC_SolicitudEstado: "0", U_UC_SolicitudDetalle: String(body.detalle).slice(0, 250) }] });
        out.mensaje = l.ItemCode + " enviado a " + TIPOS[tipo]; return;
      }
      if (req.method === "POST" && body.accion === "anular_solicitud") {
        const o = await pedido(body.entry); const l = (o.DocumentLines || []).find((x) => Number(x.LineNum) === Number(body.linea)); if (!l) throw new Error("línea no encontrada");
        await sl.patch(`Orders(${o.DocEntry})`, { DocumentLines: [{ LineNum: l.LineNum, U_UC_Solicitud: "0", U_UC_SolicitudEstado: "0" }] });
        out.mensaje = "Solicitud quitada de " + l.ItemCode; return;
      }
      if (req.method === "POST" && body.accion === "fecha") {
        if (!F(body.fecha)) throw new Error("elige la nueva fecha de servicio");
        if (body.fecha < new Date().toISOString().slice(0, 10)) throw new Error("la fecha no puede ser anterior a hoy");
        const o = await pedido(body.entry); const ab = (o.DocumentLines || []).filter((x) => x.LineStatus !== "bost_Close");
        const L = body.linea !== undefined && body.linea !== null && body.linea !== "" ? ab.filter((x) => Number(x.LineNum) === Number(body.linea)) : ab;
        if (!L.length) throw new Error("línea no encontrada");
        const cambio = { DocumentLines: L.map((x) => ({ LineNum: x.LineNum, ShipDate: body.fecha })) };
        if (L.length === ab.length || body.fecha > String(o.DocDueDate || "").slice(0, 10)) cambio.DocDueDate = body.fecha;
        await sl.patch(`Orders(${o.DocEntry})`, cambio);
        out.mensaje = "Fecha de servicio cambiada al " + body.fecha.split("-").reverse().join("/") + (L.length === 1 ? " (" + L[0].ItemCode + ")" : " (todo el pedido)"); return;
      }
      // ===== Panel de producción y compras =====
      if (req.method === "GET" && q.almacenes !== undefined) {
        const r = await todas("Warehouses?$select=WarehouseCode,WarehouseName,Inactive&$orderby=WarehouseCode", 300);
        out.almacenes = r.filter((w) => w.Inactive !== "tYES").map((w) => ({ codigo: w.WarehouseCode, nombre: w.WarehouseName })); return;
      }
      const lineaDe = async () => { const o = await pedido(body.entry); const l = (o.DocumentLines || []).find((x) => Number(x.LineNum) === Number(body.linea)); if (!l) throw new Error("línea no encontrada"); if (!TIPOS[String(l.U_UC_Solicitud ?? "0")]) throw new Error("esta línea ya no está mandada a producción ni a compras"); return { o, l }; };
      const ponLinea = (o, l, campos) => sl.patch(`Orders(${o.DocEntry})`, { DocumentLines: [{ LineNum: l.LineNum, ...campos }] });
      const nota = (l, t) => (String(l.U_UC_SolicitudDetalle || "") + (t ? " | " + t : "")).slice(-250);
      if (req.method === "POST" && body.accion === "en_proceso") {
        const { o, l } = await lineaDe(); await ponLinea(o, l, { U_UC_SolicitudEstado: "1", ...(body.nota ? { U_UC_SolicitudDetalle: nota(l, body.nota) } : {}) });
        out.mensaje = l.ItemCode + " marcado «en proceso»"; return;
      }
      if (req.method === "POST" && body.accion === "confirmar") {
        if (!F(body.fecha)) throw new Error("pon la fecha en que estará listo (es obligatoria)");
        if (body.fecha < new Date().toISOString().slice(0, 10)) throw new Error("la fecha no puede ser anterior a hoy");
        const { o, l } = await lineaDe();
        await ponLinea(o, l, { U_UC_SolicitudEstado: "2", ShipDate: body.fecha, U_UC_SolicitudDetalle: nota(l, "Confirmado para el " + body.fecha.split("-").reverse().join("/") + (body.nota ? ": " + body.nota : "")) });
        out.mensaje = l.ItemCode + " confirmado para el " + body.fecha.split("-").reverse().join("/") + " · Customer Service lo verá para reconfirmar con el cliente"; return;
      }
      if (req.method === "POST" && body.accion === "devolver") {
        if (String(body.motivo || "").trim().length < 3) throw new Error("escribe por qué se devuelve (es obligatorio)");
        const { o, l } = await lineaDe();
        await ponLinea(o, l, { U_UC_Solicitud: "0", U_UC_SolicitudEstado: "0", U_UC_SolicitudDetalle: nota(l, "DEVUELTO por " + (TIPOS[String(l.U_UC_Solicitud)] || "") + ": " + body.motivo) });
        out.mensaje = l.ItemCode + " devuelto a Customer Service"; return;
      }
      if (req.method === "POST" && body.accion === "compra_hecha") {
        const { o, l } = await lineaDe();
        await ponLinea(o, l, { U_UC_SolicitudEstado: "3", U_UC_SolicitudDetalle: nota(l, "Compra pedida" + (body.nota ? ": " + body.nota : "")) });
        out.mensaje = l.ItemCode + " marcado «compra pedida»"; return;
      }
      if (req.method === "POST" && body.accion === "ordenar") {
        if (!F(body.fecha)) throw new Error("falta el día de fabricación"); if (!body.almacen) throw new Error("falta el almacén donde se fabrica");
        const uds = Number(body.uds); if (!(uds > 0)) throw new Error("falta la cantidad a fabricar");
        const { o, l } = await lineaDe();
        let tieneBom = false; try { await sl.get(`ProductTrees('${esc(l.ItemCode)}')?$select=TreeCode`); tieneBom = true; } catch (e) {}
        if (!tieneBom) throw new Error(l.ItemCode + " no tiene receta (escandallo) en SAP: no se puede ordenar la producción");
        const base = { ItemNo: l.ItemCode, PlannedQuantity: uds, Warehouse: String(body.almacen).toUpperCase(), PostingDate: new Date().toISOString().slice(0, 10), StartDate: body.fecha, DueDate: body.fecha, ProductionOrderStatus: "boposPlanned", ProductionOrderType: "bopotStandard",
          Remarks: ("PV:" + o.DocNum + "/" + l.LineNum + " · " + o.CardName + (body.nota ? " · " + body.nota : "")).slice(0, 254) };
        let r; try { r = await sl.post("ProductionOrders", Object.assign({ ProductionOrderOrigin: "bopooSalesOrder", ProductionOrderOriginEntry: o.DocEntry, CustomerCode: o.CardCode }, base)); }
        catch (e) { r = await sl.post("ProductionOrders", base); }
        await ponLinea(o, l, { U_UC_SolicitudEstado: "3", U_UC_SolicitudDetalle: nota(l, "Orden de fabricación " + r.DocumentNumber + " para el " + body.fecha.split("-").reverse().join("/")) });
        out.orden = r.DocumentNumber; out.mensaje = "Orden de fabricación " + r.DocumentNumber + " creada: " + uds + " de " + l.ItemCode + " para el " + body.fecha.split("-").reverse().join("/"); return;
      }
      throw new Error("petición no reconocida");
    });
  } catch (e) { out.ok = false; out.error = String(e.message || e).slice(0, 600); }
  out.segundos = Math.round((Date.now() - t0) / 100) / 10;
  return res.status(out.ok ? 200 : 400).json(out);
};
module.exports.config = { maxDuration: 60 };
