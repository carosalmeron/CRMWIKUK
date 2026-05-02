// /api/debug-fb.js
// Diagnóstico completo: Firebase + colecciones + usuarios + SMTP
// Usar: https://crmwikuk.vercel.app/api/debug-fb?manual=1

const FB_BASE = "https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents";

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
    const text = await res.text();
    if (!res.ok) {
      return { error: true, status: res.status, body: text.substring(0, 500) };
    }
    const json = JSON.parse(text);
    if (!json.documents) return { error: false, count: 0, docs: [] };
    const docs = json.documents.map(d => {
      const id = d.name.split("/").pop();
      return { id, ...fsToObj(d) };
    });
    return { error: false, count: docs.length, docs };
  } catch (err) {
    return { error: true, message: err.message };
  }
}

export default async function handler(req, res) {
  if (req.query.manual !== "1") {
    return res.status(401).json({ error: "Usa ?manual=1" });
  }

  const resultado = {
    timestamp: new Date().toISOString(),
    projectId: "grupo-consolidado-crm",
    smtp: {
      SMTP_HOST: process.env.SMTP_HOST ? "✅ configurado" : "❌ FALTA",
      SMTP_PORT: process.env.SMTP_PORT || "❌ FALTA",
      SMTP_USER: process.env.SMTP_USER ? "✅ " + process.env.SMTP_USER.substring(0, 5) + "..." : "❌ FALTA",
      SMTP_PASS: process.env.SMTP_PASS ? "✅ configurado" : "❌ FALTA",
      SMTP_FROM: process.env.SMTP_FROM || "(usará SMTP_USER)",
    },
    colecciones: {},
  };

  // Test cada colección
  const cols = ["usuarios", "visitas", "oportunidades", "estrategias", "incidencias", "muestras"];

  for (const col of cols) {
    const data = await fbList(col);

    if (data.error) {
      resultado.colecciones[col] = { status: "❌ ERROR", detalle: data };
    } else {
      const info = {
        status: "✅ OK",
        total: data.count,
      };

      if (col === "usuarios") {
        const conEmail = data.docs.filter(u => u.email);
        const sinEmail = data.docs.filter(u => !u.email);
        const agentes = data.docs.filter(u => u.rol === "agente" || u.rol === "crm_agente");
        const managers = data.docs.filter(u => ["jefe", "director", "ceo"].includes(u.rol));

        info.conEmail = conEmail.length;
        info.sinEmail = sinEmail.length;
        info.agentes = agentes.length;
        info.agentesConEmail = agentes.filter(u => u.email).length;
        info.managers = managers.length;
        info.managersConEmail = managers.filter(u => u.email).length;
        info.roles = [...new Set(data.docs.map(u => u.rol))];
        info.equipos = [...new Set(data.docs.map(u => u.equipo).filter(Boolean))];
        // Muestra primeros 5 usuarios (sin datos sensibles)
        info.muestra = data.docs.slice(0, 8).map(u => ({
          id: u.id,
          nombre: u.nombre,
          rol: u.rol,
          equipo: u.equipo,
          email: u.email ? u.email.substring(0, 10) + "..." : "❌ SIN EMAIL",
          campos: Object.keys(u).join(", "),
        }));
      } else {
        // Para otras colecciones: campos y muestra de fechas
        if (data.count > 0) {
          const sample = data.docs[0];
          info.camposEjemplo = Object.keys(sample);
          // Buscar campos de fecha
          const fechaCampos = ["fecha", "fechaCreacion", "creadoEn", "semana", "ts"];
          info.camposFechaEncontrados = {};
          for (const fk of fechaCampos) {
            const conCampo = data.docs.filter(d => d[fk] !== undefined && d[fk] !== null && d[fk] !== "");
            if (conCampo.length > 0) {
              info.camposFechaEncontrados[fk] = {
                count: conCampo.length,
                ejemplos: conCampo.slice(0, 3).map(d => d[fk]),
              };
            }
          }
          // Muestra 2 docs
          info.muestra = data.docs.slice(0, 2).map(d => {
            const obj = {};
            for (const k of Object.keys(d).slice(0, 12)) obj[k] = d[k];
            return obj;
          });
        }
      }

      resultado.colecciones[col] = info;
    }
  }

  // Resumen rápido
  const uCol = resultado.colecciones.usuarios;
  resultado.diagnostico = [];

  if (uCol.status !== "✅ OK") {
    resultado.diagnostico.push("🔴 No se puede leer la colección 'usuarios' - verificar reglas Firestore");
  } else if (uCol.total === 0) {
    resultado.diagnostico.push("🔴 Colección 'usuarios' vacía - no hay usuarios registrados");
  } else if (uCol.agentesConEmail === 0 && uCol.managersConEmail === 0) {
    resultado.diagnostico.push("🔴 Ningún usuario tiene email - los emails no se enviarán");
  } else {
    resultado.diagnostico.push(`🟢 ${uCol.agentesConEmail} agentes y ${uCol.managersConEmail} managers con email`);
  }

  for (const col of cols.filter(c => c !== "usuarios")) {
    const c = resultado.colecciones[col];
    if (c.status !== "✅ OK") {
      resultado.diagnostico.push(`🔴 Colección '${col}' inaccesible`);
    } else if (c.total === 0) {
      resultado.diagnostico.push(`🟡 Colección '${col}' vacía (0 docs)`);
    } else {
      resultado.diagnostico.push(`🟢 ${col}: ${c.total} documentos`);
    }
  }

  if (!process.env.SMTP_HOST || !process.env.SMTP_PASS) {
    resultado.diagnostico.push("🔴 SMTP no configurado - los emails no se enviarán");
  } else {
    resultado.diagnostico.push("🟢 SMTP configurado");
  }

  return res.status(200).json(resultado);
}
