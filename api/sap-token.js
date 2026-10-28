// api/sap-token.js — Pase para las pantallas de SAP (pedidos, facturas, producción, traslados) sin teclear la clave.
//
// El portal lo pide al entrar el usuario (con su usuario y el hash de su contraseña, el mismo que guarda el portal).
// Si el usuario existe, no está bloqueado y tiene permiso (EN PRUEBAS SOLO EL CEO; con la variable SAP_SOLO_CEO=no
// también admin/director y quien tenga el acceso «pedido_sap» o «produccion»),
// devuelve un pase firmado válido 30 días. Las APIs de SAP aceptan ese pase en lugar de la clave SAP_PEDIDOS_KEY.
const crypto = require("crypto");
const env = (k) => { const v = process.env[k]; return v === undefined ? undefined : String(v).trim(); };
const FB = () => `https://firestore.googleapis.com/v1/projects/${env("FB_PROJECT_ID") || "grupo-consolidado-crm"}/databases/(default)/documents`;
const val = (f) => { if (!f) return null; if (f.stringValue !== undefined) return f.stringValue; if (f.booleanValue !== undefined) return f.booleanValue; if (f.integerValue !== undefined) return Number(f.integerValue); if (f.doubleValue !== undefined) return Number(f.doubleValue); if (f.arrayValue) return (f.arrayValue.values || []).map(val); if (f.mapValue) { const o = {}; for (const [k, x] of Object.entries(f.mapValue.fields || {})) o[k] = val(x); return o; } return null; };
// Busca al usuario en portal_users y en usuarios por id, nombre de usuario o nombre (como hace el login del portal)
async function listar(col) {
  const out = []; let tok = "";
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`${FB()}/${col}?pageSize=300${tok ? "&pageToken=" + encodeURIComponent(tok) : ""}${env("FB_API_KEY") ? "&key=" + env("FB_API_KEY") : ""}`);
    if (!r.ok) break; const j = await r.json();
    for (const d of (j.documents || [])) { const o = {}; for (const [k, x] of Object.entries(d.fields || {})) o[k] = val(x); o._docId = decodeURIComponent(d.name.split("/").pop()); o._col = col; if (!o.id) o.id = o._docId; out.push(o); }
    if (!j.nextPageToken) break; tok = j.nextPageToken;
  }
  return out;
}
async function buscarUsuarios(t) {
  t = String(t || "").trim().toLowerCase(); const res = [];
  for (const col of ["portal_users", "usuarios"]) for (const u of await listar(col)) {
    if ([u.id, u._docId, u.username, u.nombre].some((x) => x && String(x).trim().toLowerCase() === t)) res.push(u);
  }
  return res;
}
const secreto = () => env("SAP_PEDIDOS_KEY") || env("CRON_SECRET") || "";
function firmar(payload) { const p = Buffer.from(JSON.stringify(payload)).toString("base64url"); const h = crypto.createHmac("sha256", secreto()).update(p).digest("base64url"); return "crm." + p + "." + h; }
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  // Diagnóstico: GET ?diag=usuario&key=SAP_PEDIDOS_KEY → qué fichas encuentra y si tienen contraseña guardada (sin enseñarla)
  if (req.method === "GET" && req.query && req.query.diag) {
    if (!secreto() || req.query.key !== secreto()) return res.status(401).json({ ok: false, error: "clave incorrecta" });
    const C = await buscarUsuarios(req.query.diag);
    return res.status(200).json({ ok: true, buscado: req.query.diag, encontrados: C.map((u) => ({ coleccion: u._col, docId: u._docId, id: u.id, username: u.username || null, nombre: u.nombre || null, rol: u.rol || null, bloqueado: !!u.bloqueado, tieneHash: !!u.passHash, tieneClaveAntigua: !!u.pass, accesos: u.accesos || [] })), soloCeo: env("SAP_SOLO_CEO") !== "no" });
  }
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "usa POST" });
  if (!secreto()) return res.status(500).json({ ok: false, error: "falta SAP_PEDIDOS_KEY en Vercel" });
  let b = req.body; if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } } b = b || {};
  let id = String(b.usuario || "").trim(); const h = String(b.passHash || "").trim().toLowerCase();
  if (!id || !/^[a-f0-9]{64}$/.test(h)) return res.status(400).json({ ok: false, error: "faltan usuario o clave" });
  try {
    const C = await buscarUsuarios(id);
    if (!C.length) return res.status(401).json({ ok: false, error: "no encuentro el usuario «" + id + "» en el portal" });
    const sha = (x) => crypto.createHash("sha256").update(String(x)).digest("hex");
    // Contraseña: hash guardado o, en fichas antiguas, la clave en claro
    const u = C.find((x) => (x.passHash && String(x.passHash).toLowerCase() === h) || (x.pass && sha(String(x.pass).trim()) === h));
    if (!u) return res.status(401).json({ ok: false, error: "la contraseña no coincide con la del portal para «" + id + "»" });
    if (u.bloqueado) return res.status(403).json({ ok: false, error: "usuario bloqueado" });
    id = String(u.id || u._docId); const rol = String(u.rol || "").toLowerCase(), acc = (u.accesos || []).map((x) => String(x).toLowerCase());
    // En pruebas: solo el CEO. Para abrirlo, cambia SOLO_CEO a false (entonces valen admin/director y los accesos «pedido_sap» / «produccion»)
    const SOLO_CEO = env("SAP_SOLO_CEO") !== "no";
    const esCeo = id === "ceo" || rol === "ceo";
    const puede = esCeo || (!SOLO_CEO && (["admin", "crm_director"].includes(rol) || acc.includes("pedido_sap") || acc.includes("produccion")));
    if (!puede) return res.status(403).json({ ok: false, error: SOLO_CEO ? "en pruebas: solo el CEO" : "sin permiso para SAP (acceso «pedido_sap» o «produccion»)" });
    const exp = Date.now() + 30 * 86400000;
    return res.status(200).json({ ok: true, token: firmar({ u: id, n: u.nombre || id, exp }), caduca: new Date(exp).toISOString().slice(0, 10) });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
};
