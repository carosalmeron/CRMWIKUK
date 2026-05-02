// /api/debug-fb.js
// Endpoint de diagnóstico para verificar qué se lee de Firebase.
// Acceder con ?key=VALORDEDEBUG (cualquier string) para ver:
//   - Conteo de documentos en cada colección
//   - Primer documento de cada colección (sample)
//   - Configuración leída del entorno

const FB_BASE = "https://firestore.googleapis.com/v1/projects/crmwikuk/databases/(default)/documents";

function fsToObj(doc) {
  if (!doc || !doc.fields) return null;
  const out = {};
  for (const k in doc.fields) {
    const v = doc.fields[k];
    if (v.stringValue !== undefined) out[k] = v.stringValue;
    else if (v.integerValue !== undefined) out[k] = parseInt(v.integerValue);
    else if (v.doubleValue !== undefined) out[k] = parseFloat(v.doubleValue);
    else if (v.booleanValue !== undefined) out[k] = v.booleanValue;
    else if (v.timestampValue !== undefined) out[k] = v.timestampValue;
    else if (v.nullValue !== undefined) out[k] = null;
    else if (v.arrayValue) out[k] = "[array]";
    else if (v.mapValue) out[k] = "{map}";
  }
  return out;
}

async function fbList(coleccion) {
  const url = `${FB_BASE}/${coleccion}?pageSize=1000`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const txt = await res.text();
      return { error: true, status: res.status, body: txt.substring(0, 500) };
    }
    const json = await res.json();
    if (!json.documents) return { count: 0, items: [], raw: json };
    return {
      count: json.documents.length,
      items: json.documents.slice(0, 3).map(d => ({
        id: d.name.split("/").pop(),
        ...fsToObj(d),
      })),
    };
  } catch (err) {
    return { error: true, message: err.message };
  }
}

export default async function handler(req, res) {
  const colecciones = [
    "usuarios", "Usuarios", "USUARIOS",
    "visitas", "Visitas",
    "oportunidades", "Oportunidades",
    "estrategias", "Estrategias",
    "incidencias", "muestras",
    "clientes", "tareas", "proyectos",
    "configuracion",
  ];

  const out = {};
  for (const col of colecciones) {
    out[col] = await fbList(col);
  }

  return res.status(200).json({
    fb_base: FB_BASE,
    env: {
      SMTP_HOST: process.env.SMTP_HOST ? "✅ configurado" : "❌ falta",
      SMTP_USER: process.env.SMTP_USER ? "✅ configurado" : "❌ falta",
      SMTP_PASS: process.env.SMTP_PASS ? "✅ configurado" : "❌ falta",
      SMTP_FROM: process.env.SMTP_FROM ? "✅ configurado" : "❌ falta",
      SMTP_PORT: process.env.SMTP_PORT || "(default 587)",
    },
    colecciones: out,
  });
}
