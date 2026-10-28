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
async function leerUsuario(id) {
  for (const col of ["portal_users", "usuarios"]) {
    const r = await fetch(`${FB()}/${col}/${encodeURIComponent(id)}${env("FB_API_KEY") ? "?key=" + env("FB_API_KEY") : ""}`);
    if (!r.ok) continue; const j = await r.json(); const o = {}; for (const [k, x] of Object.entries(j.fields || {})) o[k] = val(x); o._col = col; return o;
  }
  return null;
}
const secreto = () => env("SAP_PEDIDOS_KEY") || env("CRON_SECRET") || "";
function firmar(payload) { const p = Buffer.from(JSON.stringify(payload)).toString("base64url"); const h = crypto.createHmac("sha256", secreto()).update(p).digest("base64url"); return "crm." + p + "." + h; }
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "usa POST" });
  if (!secreto()) return res.status(500).json({ ok: false, error: "falta SAP_PEDIDOS_KEY en Vercel" });
  let b = req.body; if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } } b = b || {};
  const id = String(b.usuario || "").trim(), h = String(b.passHash || "").trim().toLowerCase();
  if (!id || !/^[a-f0-9]{64}$/.test(h)) return res.status(400).json({ ok: false, error: "faltan usuario o clave" });
  try {
    const u = await leerUsuario(id);
    if (!u || !u.passHash || String(u.passHash).toLowerCase() !== h) return res.status(401).json({ ok: false, error: "usuario o clave incorrectos" });
    if (u.bloqueado) return res.status(403).json({ ok: false, error: "usuario bloqueado" });
    const rol = String(u.rol || "").toLowerCase(), acc = (u.accesos || []).map((x) => String(x).toLowerCase());
    // En pruebas: solo el CEO. Para abrirlo, cambia SOLO_CEO a false (entonces valen admin/director y los accesos «pedido_sap» / «produccion»)
    const SOLO_CEO = env("SAP_SOLO_CEO") !== "no";
    const esCeo = id === "ceo" || rol === "ceo";
    const puede = esCeo || (!SOLO_CEO && (["admin", "crm_director"].includes(rol) || acc.includes("pedido_sap") || acc.includes("produccion")));
    if (!puede) return res.status(403).json({ ok: false, error: SOLO_CEO ? "en pruebas: solo el CEO" : "sin permiso para SAP (acceso «pedido_sap» o «produccion»)" });
    const exp = Date.now() + 30 * 86400000;
    return res.status(200).json({ ok: true, token: firmar({ u: id, n: u.nombre || id, exp }), caduca: new Date(exp).toISOString().slice(0, 10) });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 200) }); }
};
