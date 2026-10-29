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
// Planificación: GET ?plan=1[&desde=] · POST global(articulo,uds,desde,hasta,almacen) · hija(global,uds,fecha[,entry,linea,liberar]) · liberar(abs)
// MRP: POST {accion:"mrp", hasta, aceptados, extra:[{art,uds,fecha}]} (solo lee) · POST {accion:"solicitud_compra", lineas:[{art,uds,fecha}]}
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
  const del = async (ruta) => { const r = await pedir(base, ruta, { method: "DELETE", cookies, ca, insecure }); if (r.status >= 300) throw new Error("SAP no ha borrado " + ruta + " (" + r.status + "): " + msgDe(r)); return true; };
  try { return await fn({ get, post, patch, del }); }
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
const body0 = (req) => { let b = req.body; if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } } return b || {}; };
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
  if (AUT.soloVer && req.method === "POST" && env("CS_SOLO_VER") === "si" && (body0(req).accion !== "mrp")) return res.status(403).json({ ok: false, error: "puedes ver el panel, pero ahora mismo los cambios están desactivados" });
  if (!AUT.ok) return res.status(401).json({ ok: false, error: AUT.caducado ? "el pase ha caducado: vuelve a entrar en el portal" : "clave incorrecta" });
  let body = req.body; if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } } body = body || {};
  const db = String(body.db || q.db || env("SAP_DB") || "U_CARO_00"); if (!DB_OK(db)) return res.status(400).json({ ok: false, error: "base de datos no válida" });
  const out = { ok: true, db, quien: AUT.quien || "", puedeEscribir: !(AUT.soloVer && env("CS_SOLO_VER") === "si") }; const t0 = Date.now();
  try {
    await conSesion(db, async (sl) => {
      const todas = async (ruta, max = 3000) => { let o = [], r = await sl.get(ruta); for (;;) { o.push(...(r.value || [])); const sig = r["odata.nextLink"] || r["@odata.nextLink"]; if (!sig || o.length >= max) break; r = await sl.get(String(sig).replace(/^.*\/b1s\/v\d\//, "")); } return o; };
      const pedido = async (entry) => { const o = await sl.get(`Orders(${Number(entry)})?$select=DocEntry,DocNum,CardName,DocumentStatus,Confirmed,DocumentLines`); if (o.DocumentStatus !== "bost_Open") throw new Error("el pedido " + o.DocNum + " ya está cerrado"); return o; };

      // Diagnóstico: qué valores tienen los campos propios (U_) de cabecera en los pedidos abiertos
      // Envasado: GET ?envasado=GRANEL → lotes del granel con existencias y formatos de envase (artículos GRANEL.xxx con su receta)
      if (req.method === "GET" && q.envasado) {
        const g = String(q.envasado).toUpperCase().trim();
        const it = await sl.get(`Items('${esc(g)}')?$select=ItemCode,ItemName,InventoryUOM,ManageBatchNumbers,ItemWarehouseInfoCollection`);
        out.granel = { cod: it.ItemCode, nom: it.ItemName, ud: it.InventoryUOM || "", lotes: it.ManageBatchNumbers === "tYES", stock: (it.ItemWarehouseInfoCollection || []).filter((w) => Number(w.InStock) > 0).map((w) => ({ alm: w.WarehouseCode, stock: r3(w.InStock), libre: r3((Number(w.InStock) || 0) - (Number(w.Committed) || 0)) })) };
        // Lotes con existencias (consulta guardada sobre OIBT, la misma que usa la factura)
        const NOMBRE = "CRM_LotesStock"; let lotes = null;
        const sqls = [`SELECT T0."ItemCode", T0."BatchNum", T0."WhsCode", T0."Quantity", T0."ExpDate", T0."InDate" FROM OIBT T0 WHERE T0."ItemCode" = :ItemCode AND T0."Quantity" > 0`, `SELECT T0.ItemCode, T0.BatchNum, T0.WhsCode, T0.Quantity, T0.ExpDate, T0.InDate FROM OIBT T0 WHERE T0.ItemCode = :ItemCode AND T0.Quantity > 0`];
        for (let i = 0; i < 2 && !lotes; i++) { try { const r = await sl.get(`SQLQueries('${NOMBRE}')/List?ItemCode='${esc(g)}'`); lotes = r.value || []; }
          catch (e) { if (i === 0) { for (const sq of sqls) { try { await sl.post("SQLQueries", { SqlCode: NOMBRE, SqlName: "Lotes con stock por almacén (CRM)", SqlText: sq }); break; } catch (e2) {} } } } }
        out.lotes = (lotes || []).map((l) => ({ lote: l.BatchNum, alm: l.WhsCode, uds: r3(l.Quantity), caduca: D(l.ExpDate), entrada: D(l.InDate) })).sort((a, b) => String(a.caduca || "9").localeCompare(String(b.caduca || "9")) || String(a.entrada).localeCompare(String(b.entrada)));
        if (!lotes) out.avisoLotes = "no se han podido leer los lotes con cantidades";
        // Formatos: artículos cuyo código empieza por GRANEL. (p. ej. MX243.20R2.C140); unidades por envase y embalaje desde su receta
        const fm = await todas(`Items?$select=ItemCode,ItemName,InventoryUOM,Frozen&$filter=startswith(ItemCode,'${esc(g)}.')`, 200);
        out.formatos = await Promise.all(fm.filter((x) => x.Frozen !== "tYES").map(async (x) => {
          const f = { cod: x.ItemCode, nom: x.ItemName, ud: x.InventoryUOM || "", receta: false, porEnvase: null, embalaje: [] };
          try { const t = await sl.get(`ProductTrees('${esc(x.ItemCode)}')?$select=Quantity,ProductTreeLines`); const b = Number(t.Quantity) || 1; f.receta = true;
            for (const l of (t.ProductTreeLines || [])) { if (!l.ItemCode) continue; const por = (Number(l.Quantity) || 0) / b; if (l.ItemCode === g) f.porEnvase = Math.round(por * 1e6) / 1e6; else f.embalaje.push({ cod: l.ItemCode, nom: l.ItemName || "", porEnvase: Math.round(por * 1e6) / 1e6 }); } } catch (e) {}
          if (f.porEnvase === null) { const m = x.ItemCode.slice(g.length + 1).match(/(\d+)/); f.porEnvaseSugerido = m ? Number(m[1]) : null; }
          return f; }));
        return;
      }
      // Receta (lista de materiales) de un artículo: GET ?receta=ART&uds=1000 → componentes con stock libre y si a su vez tienen receta
      if (req.method === "GET" && q.receta) {
        const art = String(q.receta).toUpperCase(), uds = Number(q.uds) || 0;
        let t; try { t = await sl.get(`ProductTrees('${esc(art)}')?$select=TreeCode,Quantity,TreeType,Warehouse,ProductTreeLines`); } catch (e) { out.receta = null; out.mensaje = art + " no tiene receta en SAP"; return; }
        const base = Number(t.Quantity) || 1, L = (t.ProductTreeLines || []).filter((x) => x.ItemCode);
        const cods = [...new Set(L.map((x) => x.ItemCode))], inf = {}, conBom = {};
        for (let i = 0; i < cods.length; i += 40) { const z = cods.slice(i, i + 40); try { const r = await sl.get(`Items?$select=ItemCode,ItemName,InventoryUOM,ItemWarehouseInfoCollection&$filter=${encodeURIComponent(z.map((c) => `ItemCode eq '${esc(c)}'`).join(" or "))}&$top=100`);
          for (const it of (r.value || [])) { let st = 0, co = 0, pe = 0; for (const w of (it.ItemWarehouseInfoCollection || [])) { st += Number(w.InStock) || 0; co += Number(w.Committed) || 0; pe += Number(w.Ordered) || 0; } inf[it.ItemCode] = { nom: it.ItemName, ud: it.InventoryUOM || "", libre: r3(st - co), stock: r3(st), enCompra: r3(pe) }; } } catch (e) {} }
        await Promise.all(cods.map(async (c) => { try { await sl.get(`ProductTrees('${esc(c)}')?$select=TreeCode`); conBom[c] = true; } catch (e) { conBom[c] = false; } }));
        out.receta = { art, base, tipo: t.TreeType, almacen: t.Warehouse || "", uds, lineas: L.map((x) => { const i = inf[x.ItemCode] || {}, por = (Number(x.Quantity) || 0) / base, nec = uds ? r3(por * uds) : null;
          return { cod: x.ItemCode, nom: i.nom || x.ItemName || "", ud: i.ud || "", cantidad: Number(x.Quantity) || 0, porUnidad: Math.round(por * 1e6) / 1e6, necesita: nec, libre: i.libre ?? null, stock: i.stock ?? null, enCompra: i.enCompra ?? null, alm: x.Warehouse || "", semi: !!conBom[x.ItemCode], falta: nec !== null && i.libre !== undefined ? r3(Math.max(0, nec - Math.max(0, i.libre))) : null }; }) };
        return;
      }
      // Diagnóstico beas: GET ?beas=1[&articulo=X] → ¿hay recetas en SAP estándar? ¿se pueden leer las tablas de beas?
      if (req.method === "GET" && q.beas !== undefined) {
        const R = {}; const prueba = async (k, f) => { try { R[k] = await f(); } catch (e) { R[k] = "✗ " + String(e.message || e).slice(0, 200); } };
        await prueba("recetasSAP", async () => { const r = await sl.get("ProductTrees/$count"); return typeof r === "number" ? r : r; });
        await prueba("ejemploRecetaSAP", async () => { const r = await sl.get("ProductTrees?$select=TreeCode,TreeType,Quantity&$top=5"); return (r.value || []).map((x) => x.TreeCode + " (" + x.TreeType + ")"); });
        const art = String(q.articulo || "").toUpperCase();
        if (art) await prueba("recetaSAPdeArticulo", async () => { const t = await sl.get(`ProductTrees('${esc(art)}')`); return { cantidad: t.Quantity, lineas: (t.ProductTreeLines || []).map((l) => l.ItemCode + " × " + l.Quantity) }; });
        // Tablas de beas por consulta guardada (si SAP lo permite)
        const tablas = ["BEAS_STL", "BEAS_APLPOS", "BEAS_FTSTL", "BEAS_FTHAUPT"];
        // SAP no admite SELECT *: se prueban columnas una a una (consulta temporal que se borra después)
        const consulta = async (code, sql, top) => { try { await sl.post("SQLQueries", { SqlCode: code, SqlName: "Prueba CRM", SqlText: sql }); } catch (e) { if (!/already|exist|duplic/i.test(String(e.message))) throw e; await sl.patch(`SQLQueries('${code}')`, { SqlText: sql }); }
          try { const r = await sl.get(`SQLQueries('${code}')/List?$top=${top || 3}`); return r.value || []; } finally { try { await pedirBorrar(code); } catch (e) {} } };
        const pedirBorrar = async (code) => { try { await sl.del(`SQLQueries('${code}')`); } catch (e) {} };
        await prueba("columnasPorCatalogo", async () => { const v = await consulta("CRM_B_COLS", "SELECT T0.TABLE_NAME, T0.COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS T0 WHERE T0.TABLE_NAME LIKE 'BEAS_STL%' OR T0.TABLE_NAME LIKE 'BEAS_FT%'", 400); return v.map((x) => x.TABLE_NAME + "." + x.COLUMN_NAME); });
        const CAND = { BEAS_STL: ["ItemCode", "POS_ID", "ART1_ID", "ItemName", "BEZ", "MENGE", "MENGE_JE", "MENGE_VERBRAUCH", "MENGE_LAGER", "ME_VERBR", "ME_LAGER", "UMRECHNUNG", "WhsCode", "SORTID", "AUSSCHUSS", "VERSCHNITT", "POS_TEXT", "ArtikelID", "DistNumber", "VERSION", "ART_ID", "KOMP_ID", "SubItemCode", "Quantity"],
          BEAS_FTHAUPT: ["BELNR_ID", "ItemCode", "MENGE", "STATUS", "CardCode"] };
        for (const [t, cols] of Object.entries(CAND)) await prueba("columnas_" + t, async () => { const ok = [], no = [];
          for (let i = 0; i < cols.length; i++) { try { await consulta("CRM_B_C" + i, `SELECT T0.${cols[i]} FROM ${t} T0`, 1); ok.push(cols[i]); } catch (e) { no.push(cols[i] + ": " + String(e.message || "").replace(/^.*Invalid SQL syntax:/, "").slice(0, 70)); } }
          let ejemplo = null; if (ok.length) { try { ejemplo = await consulta("CRM_B_EJ", `SELECT ${ok.map((c) => "T0." + c).join(", ")} FROM ${t} T0`, 5); } catch (e) { ejemplo = "✗ " + String(e.message).slice(0, 160); } }
          return { existen: ok, ejemplo, noExisten: no.slice(0, 6) }; });
        await prueba("camposBeasEnArticulos", async () => { const r = await sl.get("Items?$top=1"); const it = (r.value || [])[0] || {}; return Object.keys(it).filter((k) => /beas/i.test(k)); });
        out.beas = R; return;
      }
      // Diagnóstico de bloqueos: GET ?bloqueos=260002888,260002877 → marcas de riesgo/precio/cobros de esos pedidos y de todos los abiertos con alguna marca
      if (req.method === "GET" && q.bloqueos !== undefined) {
        const C = "DocEntry,DocNum,CardCode,CardName,DocDate,DocTotal,Confirmed,DocumentStatus,U_SCL_InvalidadoxRiesg,U_SCL_ValidadoFijoRiesgo,U_SCL_InvalidadoxPrecios,U_SCL_ValidadoFijoPrecios,U_SCL_InvalidadoxCobros,U_SCL_ValidadoFijoCobros";
        const fila = (p) => ({ num: p.DocNum, cliente: p.CardCode + " " + String(p.CardName || "").slice(0, 28), estado: p.DocumentStatus === "bost_Open" ? "abierto" : "cerrado", confirmado: p.Confirmed === "tYES" ? "sí" : "no",
          riesgo: (p.U_SCL_InvalidadoxRiesg || "-") + "/" + (p.U_SCL_ValidadoFijoRiesgo || "-"), precio: (p.U_SCL_InvalidadoxPrecios || "-") + "/" + (p.U_SCL_ValidadoFijoPrecios || "-"), cobros: (p.U_SCL_InvalidadoxCobros || "-") + "/" + (p.U_SCL_ValidadoFijoCobros || "-") });
        const nums = String(q.bloqueos || "").split(/[^0-9]+/).filter(Boolean).slice(0, 60);
        out.leyenda = "riesgo/precio/cobros = Invalidado / ValidadoFijo";
        if (nums.length) { const r = await sl.get(`Orders?$select=${C}&$filter=${encodeURIComponent(nums.map((n) => "DocNum eq " + Number(n)).join(" or "))}&$top=100`); out.pedidos = (r.value || []).map(fila).sort((a, b) => a.num - b.num); }
        const ab = await todas(`Orders?$select=${C}&$filter=DocumentStatus eq 'bost_Open' and U_SCL_InvalidadoxRiesg eq 'Y'&$orderby=DocNum`, 1500);
        out.abiertosConRiesgoY = ab.map(fila);
        return;
      }
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
          mide("compras", async () => { try { for (const p of await todas("PurchaseOrders?$select=DocNum,DocDueDate,DocumentLines&$filter=DocumentStatus eq 'bost_Open'", 2000)) for (const l of (p.DocumentLines || [])) { const u = Number(l.RemainingOpenQuantity) || 0; if (u > 0 && l.LineStatus !== "bost_Close") addL(l.ItemCode, { fecha: D(l.ShipDate || p.DocDueDate), uds: u, de: "compra " + p.DocNum, alm: l.WarehouseCode, tipo: "comp", orden: p.DocNum }); } } catch (e) { out.avisoCompras = String(e.message).slice(0, 120); } }),
          mide("fabricacion", async () => { try { for (const o of await todas("ProductionOrders?$select=DocumentNumber,ItemNo,PlannedQuantity,CompletedQuantity,DueDate,Warehouse,ProductionOrderStatus&$filter=ProductionOrderStatus eq 'boposPlanned' or ProductionOrderStatus eq 'boposReleased'", 2000)) { const u = (Number(o.PlannedQuantity) || 0) - (Number(o.CompletedQuantity) || 0); if (u > 0) addL(o.ItemNo, { fecha: D(o.DueDate), uds: u, de: "fabricación " + o.DocumentNumber, alm: o.Warehouse, tipo: "fab", orden: o.DocumentNumber, estado: o.ProductionOrderStatus === "boposReleased" ? "Liberada" : "Planificada", hecho: Number(o.CompletedQuantity) || 0 }); } } catch (e) {} }),
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
          for (const it of (r.value || [])) { const w = {}; for (const x of (it.ItemWarehouseInfoCollection || [])) w[x.WarehouseCode] = { stock: Number(x.InStock) || 0, comp: Number(x.Committed) || 0, ped: Number(x.Ordered) || 0 }; stock[it.ItemCode] = { w, ud: it.SalesUnit || it.InventoryUOM || "" }; } } catch (e) {} }));
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
            // (29/10/2026) La lista de SAP de «invalidados por riesgo» coincide con la marca U_SCL_InvalidadoxCobros = Y (sin mirar ValidadoFijo ni si está confirmado)
            precios: Y(p.U_SCL_InvalidadoxPrecios) && !Y(p.U_SCL_ValidadoFijoPrecios), cobros: false, riesgo: Y(p.U_SCL_InvalidadoxCobros), muestras: Y(p.U_SCL_InvalidadoxMuestras) && !Y(p.U_SCL_ValidadoFijoMuestra), etapa, todoStock: L.length > 0 && L.every((l) => l.hay || (l.sol && !l.sol.pendiente)), lineas: L };
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
        // Detalle por artículo (para desplegar): stock y comprometido por almacén, órdenes de fabricación y compras abiertas
        out.articulos = {};
        for (const [c, v] of Object.entries(stock)) out.articulos[c] = {
          alm: Object.entries(v.w).filter(([, x]) => x.stock || x.comp || x.ped).map(([k, x]) => ({ alm: k, stock: r3(x.stock), comp: r3(x.comp), ped: r3(x.ped), libre: r3(x.stock - x.comp) })).sort((a, b) => b.stock - a.stock),
          fab: (lleg[c] || []).filter((x) => x.tipo === "fab"), compras: (lleg[c] || []).filter((x) => x.tipo === "comp") };
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
        // Fecha nueva o cambiada → el pedido vuelve a Customer Service para que la apruebe con el cliente
        const cambia = String(l.ShipDate || "").slice(0, 10) !== body.fecha || String(l.U_UC_SolicitudEstado) !== "2";
        await sl.patch(`Orders(${o.DocEntry})`, { ...(cambia ? { Confirmed: "tNO" } : {}), DocumentLines: [{ LineNum: l.LineNum, U_UC_SolicitudEstado: "2", ShipDate: body.fecha, U_UC_SolicitudDetalle: nota(l, "Confirmado para el " + body.fecha.split("-").reverse().join("/") + (body.nota ? ": " + body.nota : "")) }] });
        out.mensaje = l.ItemCode + " confirmado para el " + body.fecha.split("-").reverse().join("/") + " · Customer Service lo verá para reconfirmar con el cliente"; return;
      }
      if (req.method === "POST" && body.accion === "devolver") {
        if (String(body.motivo || "").trim().length < 3) throw new Error("escribe por qué se devuelve (es obligatorio)");
        const { o, l } = await lineaDe();
        await ponLinea(o, l, { U_UC_Solicitud: "0", U_UC_SolicitudEstado: "0", U_UC_SolicitudDetalle: nota(l, "DEVUELTO por " + (TIPOS[String(l.U_UC_Solicitud)] || "") + ": " + body.motivo) });
        out.mensaje = l.ItemCode + " devuelto a Customer Service"; return;
      }
      if (req.method === "POST" && body.accion === "reasignar") {
        const tipo = String(body.tipo || ""); if (!TIPOS[tipo]) throw new Error("elige a quién se pasa");
        const { o, l } = await lineaDe(); const antes = String(l.U_UC_Solicitud);
        if (antes === tipo) throw new Error("ya está en " + TIPOS[tipo]);
        await ponLinea(o, l, { U_UC_Solicitud: tipo, U_UC_SolicitudEstado: "0", U_UC_SolicitudDetalle: nota(l, "Pasado de " + (TIPOS[antes] || antes) + " a " + TIPOS[tipo] + (body.motivo ? ": " + body.motivo : "")) });
        out.mensaje = l.ItemCode + " pasado de " + (TIPOS[antes] || antes) + " a " + TIPOS[tipo]; return;
      }
      if (req.method === "POST" && body.accion === "compra_hecha") {
        const { o, l } = await lineaDe();
        await ponLinea(o, l, { U_UC_SolicitudEstado: "3", U_UC_SolicitudDetalle: nota(l, "Compra pedida" + (body.nota ? ": " + body.nota : "")) });
        out.mensaje = l.ItemCode + " marcado «compra pedida»"; return;
      }
      // ===== Planificación de producción: órdenes del periodo, globales (PG) y sus hijas (PGH:num) =====
      const ESTF = { boposPlanned: "Planificada", boposReleased: "Liberada", boposClosed: "Cerrada", boposCancelled: "Cancelada" };
      const leeOrden = (o) => { const rm = String(o.Remarks || ""), pv = rm.match(/PV:(\d+)\/(\d+)/), h = rm.match(/PGH:(\d+)/), tot = rm.match(/Total\s+([\d.,]+)/i), per = rm.match(/Periodo\s+([0-9/]+)/i);
        return { abs: o.AbsoluteEntry, num: o.DocumentNumber, art: o.ItemNo, desc: o.ProductDescription || "", uds: r3(o.PlannedQuantity), hecho: r3(o.CompletedQuantity), inicio: D(o.StartDate), fecha: D(o.DueDate), alm: o.Warehouse,
          estado: ESTF[o.ProductionOrderStatus] || o.ProductionOrderStatus, est: o.ProductionOrderStatus, cliente: o.CustomerCode || "", nota: rm.slice(0, 200),
          tipo: /^PG\b/.test(rm) ? "global" : h ? "hija" : pv ? "pedido" : "libre", padre: h ? Number(h[1]) : null, pedido: pv ? { num: Number(pv[1]), linea: Number(pv[2]) } : null,
          total: tot ? Number(tot[1].replace(/\./g, "").replace(",", ".")) : null, periodo: per ? per[1] : "" }; };
      const conReceta = async (it) => { try { await sl.get(`ProductTrees('${esc(it)}')?$select=TreeCode`); return true; } catch (e) { return false; } };
      if (req.method === "GET" && q.plan !== undefined) {
        const desde = F(q.desde) ? q.desde : new Date(Date.now() - 31 * 864e5).toISOString().slice(0, 10);
        const r = await todas(`ProductionOrders?$select=AbsoluteEntry,DocumentNumber,ItemNo,ProductDescription,PlannedQuantity,CompletedQuantity,StartDate,DueDate,Warehouse,ProductionOrderStatus,CustomerCode,Remarks&$filter=DueDate ge '${desde}' or ProductionOrderStatus eq 'boposPlanned' or ProductionOrderStatus eq 'boposReleased'&$orderby=DueDate`, 4000);
        out.ordenes = r.map(leeOrden); return;
      }
      if (req.method === "POST" && body.accion === "global") {
        const it = String(body.articulo || "").trim(), uds = Number(body.uds);
        if (!it) throw new Error("falta el artículo"); if (!(uds > 0)) throw new Error("falta la cantidad total");
        if (!F(body.desde) || !F(body.hasta)) throw new Error("falta el periodo"); if (!body.almacen) throw new Error("falta el almacén");
        if (!(await conReceta(it))) throw new Error(it + " no tiene receta (escandallo) en SAP: no se puede planificar");
        const per = body.desde.slice(5, 7) + "/" + body.desde.slice(0, 4) + (body.desde.slice(0, 7) !== body.hasta.slice(0, 7) ? "-" + body.hasta.slice(5, 7) + "/" + body.hasta.slice(0, 4) : "");
        const r = await sl.post("ProductionOrders", { ItemNo: it, PlannedQuantity: uds, Warehouse: String(body.almacen).toUpperCase(), PostingDate: new Date().toISOString().slice(0, 10), StartDate: body.desde, DueDate: body.hasta,
          ProductionOrderStatus: "boposPlanned", ProductionOrderType: "bopotStandard", Remarks: ("PG · Total " + uds + " · Periodo " + per + (body.nota ? " · " + body.nota : "")).slice(0, 254) });
        out.orden = r.DocumentNumber; out.mensaje = "Producción global " + r.DocumentNumber + " creada: " + uds + " de " + it + " para " + per; return;
      }
      if (req.method === "POST" && body.accion === "hija") {
        const uds = Number(body.uds); if (!(uds > 0)) throw new Error("falta la cantidad"); if (!F(body.fecha)) throw new Error("falta el día");
        const g = await sl.get(`ProductionOrders(${Number(body.global)})`); const G = leeOrden(g);
        if (G.tipo !== "global") throw new Error("esa orden no es una producción global");
        if (g.ProductionOrderStatus !== "boposPlanned") throw new Error("la global " + G.num + " ya está " + (ESTF[g.ProductionOrderStatus] || "cerrada"));
        if (uds > G.uds + 1e-9) throw new Error("de la global " + G.num + " solo quedan " + G.uds + " por repartir");
        let o = null, l = null; if (body.entry) { ({ o, l } = await lineaDe()); if (l.ItemCode !== G.art) throw new Error("el pedido es de otro artículo (" + l.ItemCode + ")"); }
        const base = { ItemNo: G.art, PlannedQuantity: uds, Warehouse: String(body.almacen || G.alm).toUpperCase(), PostingDate: new Date().toISOString().slice(0, 10), StartDate: body.fecha, DueDate: body.fecha, ProductionOrderStatus: "boposPlanned", ProductionOrderType: "bopotStandard",
          Remarks: ("PGH:" + G.num + (o ? " · PV:" + o.DocNum + "/" + l.LineNum + " · " + o.CardName : "") + (body.nota ? " · " + body.nota : "")).slice(0, 254) };
        let r; if (o) { try { r = await sl.post("ProductionOrders", Object.assign({ ProductionOrderOrigin: "bopooSalesOrder", ProductionOrderOriginEntry: o.DocEntry, CustomerCode: o.CardCode }, base)); } catch (e) { r = await sl.post("ProductionOrders", base); } }
        else r = await sl.post("ProductionOrders", base);
        out.orden = r.DocumentNumber; const avisos = [];
        if (body.liberar) { try { await sl.patch(`ProductionOrders(${r.AbsoluteEntry})`, { ProductionOrderStatus: "boposReleased" }); } catch (e) { avisos.push("no se ha podido liberar: " + String(e.message).slice(0, 120)); } }
        // La global baja lo que se ha sacado (así SAP no cuenta dos veces lo que se va a fabricar)
        try { const queda = r3(G.uds - uds);
          if (queda > 0) await sl.patch(`ProductionOrders(${G.abs})`, { PlannedQuantity: queda });
          else await sl.patch(`ProductionOrders(${G.abs})`, { ProductionOrderStatus: "boposCancelled", Remarks: (String(g.Remarks || "") + " · repartida entera").slice(0, 254) });
        } catch (e) { avisos.push("la global " + G.num + " no se ha podido rebajar: " + String(e.message).slice(0, 120)); }
        if (o) { try { await ponLinea(o, l, { U_UC_SolicitudEstado: "3", U_UC_SolicitudDetalle: nota(l, "Orden " + r.DocumentNumber + " (de la global " + G.num + ") para el " + body.fecha.split("-").reverse().join("/")) }); } catch (e) { avisos.push("no se ha marcado el pedido: " + String(e.message).slice(0, 100)); } }
        out.avisos = avisos; out.mensaje = "Orden " + r.DocumentNumber + " creada de la global " + G.num + ": " + uds + " para el " + body.fecha.split("-").reverse().join("/") + (o ? " (pedido " + o.DocNum + ")" : "") + (avisos.length ? " · ⚠️ " + avisos.join(" · ") : ""); return;
      }
      if (req.method === "POST" && body.accion === "liberar") {
        const g = await sl.get(`ProductionOrders(${Number(body.abs)})?$select=DocumentNumber,ProductionOrderStatus,Remarks`);
        if (/^PG\b/.test(String(g.Remarks || ""))) throw new Error("una producción global no se libera: saca de ella órdenes semanales o diarias");
        if (g.ProductionOrderStatus !== "boposPlanned") throw new Error("la orden " + g.DocumentNumber + " ya está " + (ESTF[g.ProductionOrderStatus] || ""));
        await sl.patch(`ProductionOrders(${Number(body.abs)})`, { ProductionOrderStatus: "boposReleased" }); out.mensaje = "Orden " + g.DocumentNumber + " liberada: ya se puede fabricar"; return;
      }
      // ===== MRP: explosión de recetas (varios niveles) y cruce con stock, comprometido y compras =====
      // Necesidad = órdenes PLANIFICADAS (incl. globales) + pedidos aceptados sin orden + simulación.
      // Las órdenes LIBERADAS ya están en el «comprometido» de SAP, por eso no se suman otra vez (salen como información).
      if (req.method === "POST" && body.accion === "mrp") {
        const hasta = F(body.hasta) ? body.hasta : new Date(Date.now() + 31 * 864e5).toISOString().slice(0, 10), T = {}, t0 = Date.now(), mark = (k) => { T[k] = Math.round((Date.now() - t0) / 100) / 10; };
        const dem = [], ACE = [];   // {art, uds, fecha, de}
        const ords = await todas(`ProductionOrders?$select=AbsoluteEntry,DocumentNumber,ItemNo,PlannedQuantity,CompletedQuantity,StartDate,DueDate,ProductionOrderStatus,Remarks&$filter=ProductionOrderStatus eq 'boposPlanned' or ProductionOrderStatus eq 'boposReleased'`, 4000);
        const liberadas = [];
        for (const o of ords) { const f = D(o.StartDate || o.DueDate); if (f && f > hasta) continue; const u = (Number(o.PlannedQuantity) || 0) - (Number(o.CompletedQuantity) || 0); if (u <= 0) continue;
          const de = (/^PG\b/.test(String(o.Remarks || "")) ? "global " : "orden ") + o.DocumentNumber;
          if (o.ProductionOrderStatus === "boposReleased") liberadas.push({ art: o.ItemNo, uds: r3(u), fecha: f, de }); else dem.push({ art: o.ItemNo, uds: u, fecha: f, de }); }
        mark("ordenes");
        for (const x of (body.extra || []).slice(0, 100)) if (x && x.art && Number(x.uds) > 0) dem.push({ art: String(x.art).toUpperCase(), uds: Number(x.uds), fecha: F(x.fecha) ? x.fecha : null, de: "simulación" });
        // Recetas (con caché) — ProductTrees: Quantity del padre y líneas con cantidad por esa cantidad
        const BOM = {}; const leeBom = async (c) => { if (BOM[c] !== undefined) return BOM[c]; try { const t = await sl.get(`ProductTrees('${esc(c)}')?$select=TreeCode,Quantity,ProductTreeLines`); BOM[c] = { q: Number(t.Quantity) || 1, l: (t.ProductTreeLines || []).filter((x) => x.ItemCode && String(x.ItemType || "pit_Item").includes("Item")).map((x) => ({ c: x.ItemCode, q: Number(x.Quantity) || 0 })) }; } catch (e) { BOM[c] = null; } return BOM[c]; };
        const precarga = async (cods) => { const f = [...new Set(cods)].filter((c) => BOM[c] === undefined); for (let i = 0; i < f.length; i += 8) await Promise.all(f.slice(i, i + 8).map(leeBom)); };
        // Stock por artículo (todos los almacenes)
        const INF = {}; const leeInf = async (cods) => { const f = [...new Set(cods)].filter((c) => !INF[c]); const tz = []; for (let i = 0; i < f.length; i += 40) tz.push(f.slice(i, i + 40));
          for (let i = 0; i < tz.length; i += 6) await Promise.all(tz.slice(i, i + 6).map(async (z) => { try { const r = await sl.get(`Items?$select=ItemCode,ItemName,InventoryUOM,PurchaseItem,LeadTime,ItemWarehouseInfoCollection&$filter=${encodeURIComponent(z.map((c) => `ItemCode eq '${esc(c)}'`).join(" or "))}&$top=100`);
            for (const it of (r.value || [])) { let st = 0, co = 0, pe = 0; for (const w of (it.ItemWarehouseInfoCollection || [])) { st += Number(w.InStock) || 0; co += Number(w.Committed) || 0; pe += Number(w.Ordered) || 0; }
              INF[it.ItemCode] = { nom: it.ItemName, ud: it.InventoryUOM || "", compra: it.PurchaseItem === "tYES", plazo: Number(it.LeadTime) || 0, st, co, pe }; } } catch (e) {} })); };
        if (body.aceptados) { const ped = await todas("Orders?$select=DocNum,CardName,DocDueDate,DocumentLines&$filter=DocumentStatus eq 'bost_Open'", 1500);
          for (const p of ped) for (const l of (p.DocumentLines || [])) if (l.LineStatus !== "bost_Close" && ["1", "2", "3", "6", "7"].includes(String(l.U_UC_Solicitud)) && ["0", "1", "2"].includes(String(l.U_UC_SolicitudEstado ?? "0"))) {
            const f = D(l.ShipDate || p.DocDueDate); if (f && f > hasta) continue; ACE.push({ art: l.ItemCode, uds: Number(l.RemainingOpenQuantity) || 0, fecha: f, de: "pedido " + p.DocNum + " · " + String(p.CardName || "").slice(0, 24) + (String(l.U_UC_SolicitudEstado) === "2" ? "" : " (sin confirmar)") }); }
          // Solo lo que no cubren el stock ni las órdenes que ya hay: falta = −(stock − comprometido + pedido); el comprometido ya incluye estos pedidos
          await leeInf(ACE.map((x) => x.art)); const porA = {}; for (const x of ACE) (porA[x.art] = porA[x.art] || []).push(x);
          for (const [art, xs] of Object.entries(porA)) { const i = INF[art] || { st: 0, co: 0, pe: 0 }; let falta = Math.max(0, -(i.st - i.co + i.pe)); xs.sort((a, b) => String(a.fecha || "9").localeCompare(String(b.fecha || "9")));
            for (const x of xs) { if (falta <= 0) break; const u = Math.min(falta, x.uds); falta -= u; dem.push(Object.assign({}, x, { uds: u })); } }
          mark("pedidos"); }
        // Explosión nivel a nivel; los semielaborados (con receta) se netean contra su stock antes de bajar
        const RES = {}; let nivel = [];
        await precarga(dem.map((d) => d.art));
        const SR = {}; for (const d of dem) { const b = BOM[d.art]; if (!b) { const x = SR[d.art] = SR[d.art] || { art: d.art, uds: 0, n: 0, fecha: null }; x.uds += d.uds; x.n++; if (d.fecha && (!x.fecha || d.fecha < x.fecha)) x.fecha = d.fecha; continue; } for (const x of b.l) nivel.push({ c: x.c, uds: d.uds * x.q / b.q, fecha: d.fecha, para: d.art, de: d.de, n: 1 }); }
        await leeInf(Object.keys(SR)); out.sinRecetaDet = Object.values(SR).map((x) => ({ art: x.art, nom: (INF[x.art] || {}).nom || "", ud: (INF[x.art] || {}).ud || "", uds: r3(x.uds), producciones: x.n, fecha: x.fecha })).sort((a, b) => b.uds - a.uds); out.sinReceta = out.sinRecetaDet.map((x) => x.art);
        const usado = {};
        for (let n = 1; n <= 5 && nivel.length; n++) {
          await precarga(nivel.map((x) => x.c)); await leeInf(nivel.map((x) => x.c));
          const sig = []; const porItem = {}; for (const x of nivel) (porItem[x.c] = porItem[x.c] || []).push(x);
          for (const [c, xs] of Object.entries(porItem)) {
            const r = RES[c] = RES[c] || { cod: c, nivel: n, necesita: 0, fecha: null, para: [] };
            const tot = xs.reduce((t, x) => t + x.uds, 0); r.necesita += tot;
            for (const x of xs) { if (x.fecha && (!r.fecha || x.fecha < r.fecha)) r.fecha = x.fecha; r.para.push({ art: x.para, uds: r3(x.uds), de: x.de, fecha: x.fecha }); }
            const b = BOM[c]; if (b && b.l.length) { r.semi = true; const inf = INF[c] || { st: 0, co: 0, pe: 0 }; const libre = Math.max(0, inf.st - inf.co + inf.pe - (usado[c] || 0)); const cubre = Math.min(libre, tot); usado[c] = (usado[c] || 0) + cubre; const falta = tot - cubre;
              if (falta > 1e-9) for (const x of xs) for (const y of b.l) sig.push({ c: y.c, uds: (x.uds * falta / tot) * y.q / b.q, fecha: x.fecha, para: c, de: x.de, n: n + 1 }); }
          }
          nivel = sig; mark("nivel" + n);
        }
        // Compras en camino por artículo
        const LL = {}; try { const cods = new Set(Object.keys(RES)); for (const p of await todas("PurchaseOrders?$select=DocNum,DocDueDate,CardName,DocumentLines&$filter=DocumentStatus eq 'bost_Open'", 2000)) for (const l of (p.DocumentLines || [])) { const u = Number(l.RemainingOpenQuantity) || 0; if (u > 0 && cods.has(l.ItemCode) && l.LineStatus !== "bost_Close") (LL[l.ItemCode] = LL[l.ItemCode] || []).push({ fecha: D(l.ShipDate || p.DocDueDate), uds: r3(u), num: p.DocNum }); } } catch (e) { out.avisoCompras = String(e.message).slice(0, 120); }
        const SOLS = {}; try { const cods = new Set(Object.keys(RES)); for (const p of await todas("PurchaseRequests?$select=DocNum,DocDate,RequriedDate,DocumentLines&$filter=DocumentStatus eq 'bost_Open'", 1000)) for (const l of (p.DocumentLines || [])) { const u = Number(l.RemainingOpenQuantity) || Number(l.Quantity) || 0; if (u > 0 && cods.has(l.ItemCode) && l.LineStatus !== "bost_Close") (SOLS[l.ItemCode] = SOLS[l.ItemCode] || []).push({ num: p.DocNum, uds: r3(u), fecha: D(l.RequiredDate || p.RequriedDate) }); } } catch (e) { out.avisoSolicitudes = String(e.message).slice(0, 120); }
        mark("compras");
        out.materiales = Object.values(RES).map((r) => { const i = INF[r.cod] || { st: 0, co: 0, pe: 0 }; const libre = i.st - i.co, disp = libre + i.pe, falta = r.necesita - disp, faltaHoy = r.necesita - libre;
          const ll = (LL[r.cod] || []).sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
          return { cod: r.cod, nom: i.nom || "", ud: i.ud || "", nivel: r.nivel, semi: !!r.semi, compra: !!i.compra, plazo: i.plazo, necesita: r3(r.necesita), stock: r3(i.st), comprometido: r3(i.co), enCompra: r3(i.pe), libre: r3(libre),
            solicitado: SOLS[r.cod] || [], falta: r3(Math.max(0, falta)), faltaSinCompras: r3(Math.max(0, faltaHoy)), fecha: r.fecha, llegadas: ll.slice(0, 5), llegaTarde: !!(r.fecha && ll.length && faltaHoy > 0 && ll[0].fecha > r.fecha),
            para: Object.values(r.para.reduce((m, x) => { const k = x.art + "|" + x.de; m[k] = m[k] || { art: x.art, de: x.de, uds: 0, fecha: x.fecha }; m[k].uds = r3(m[k].uds + x.uds); return m; }, {})).sort((a, b) => b.uds - a.uds).slice(0, 25) }; })
          .sort((a, b) => (b.falta > 0) - (a.falta > 0) || (b.faltaSinCompras > 0) - (a.faltaSinCompras > 0) || String(a.fecha || "9").localeCompare(String(b.fecha || "9")));
        out.demanda = { planificada: dem.length, liberadas: liberadas.length, hasta }; out.liberadas = liberadas.slice(0, 200); out.tiempos = T; return;
      }
      // Solicitud de compra desde el MRP: POST {accion:"solicitud_compra", lineas:[{art, uds, fecha}], nota}
      if (req.method === "POST" && body.accion === "solicitud_compra") {
        const L = (body.lineas || []).filter((x) => x && x.art && Number(x.uds) > 0).slice(0, 200); if (!L.length) throw new Error("no hay nada que pedir");
        const hoy = new Date().toISOString().slice(0, 10), fechas = L.map((x) => F(x.fecha) && x.fecha >= hoy ? x.fecha : hoy).sort();
        const doc = { DocDate: hoy, RequriedDate: fechas[0], Comments: ("Desde el MRP del CRM" + (AUT.quien ? " · " + AUT.quien : "") + (body.nota ? " · " + body.nota : "")).slice(0, 254),
          DocumentLines: L.map((x) => ({ ItemCode: String(x.art).toUpperCase(), Quantity: Math.round(Number(x.uds) * 1000) / 1000, RequiredDate: F(x.fecha) && x.fecha >= hoy ? x.fecha : hoy })) };
        let r; try { r = await sl.post("PurchaseRequests", doc); }
        catch (e) { const u = env("SAP_USER"); if (!u) throw e; r = await sl.post("PurchaseRequests", Object.assign({ ReqType: 12, Requester: u }, doc)); }
        out.solicitud = r.DocNum; out.mensaje = "Solicitud de compra " + r.DocNum + " creada en SAP con " + L.length + " material" + (L.length > 1 ? "es" : ""); return;
      }
      // Movimientos de almacén (entradas, salidas, traslados y solicitudes): GET ?movimientos=1&dias=7&almacen=
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
