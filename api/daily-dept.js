// /api/daily-dept.js
// Cron: 5 5 * * 1-5 (7:05 AM España, junto con el comercial)
// Envía informe diario a cada responsable de departamento con SUS incidencias/tareas

const FB = "https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents";

function fsToObj(doc) {
  if (!doc || !doc.fields) return null;
  const o = {};
  for (const k in doc.fields) {
    const v = doc.fields[k];
    if (v.stringValue !== undefined) o[k] = v.stringValue;
    else if (v.integerValue !== undefined) o[k] = parseInt(v.integerValue);
    else if (v.doubleValue !== undefined) o[k] = parseFloat(v.doubleValue);
    else if (v.booleanValue !== undefined) o[k] = v.booleanValue;
    else if (v.timestampValue !== undefined) o[k] = v.timestampValue;
    else if (v.nullValue !== undefined) o[k] = null;
    else if (v.arrayValue && v.arrayValue.values) {
      o[k] = v.arrayValue.values.map(x => {
        if (x.stringValue !== undefined) return x.stringValue;
        if (x.integerValue !== undefined) return parseInt(x.integerValue);
        if (x.mapValue) return fsToObj({ fields: x.mapValue.fields });
        return x;
      });
    } else if (v.mapValue) o[k] = fsToObj({ fields: v.mapValue.fields });
  }
  return o;
}
async function fbList(col) {
  let all = [], next = null;
  do {
    let url = `${FB}/${col}?pageSize=300`;
    if (next) url += `&pageToken=${next}`;
    const r = await fetch(url); if (!r.ok) return [];
    const j = await r.json(); next = j.nextPageToken || null;
    if (j.documents) all.push(...j.documents.map(d => ({ id: d.name.split("/").pop(), ...fsToObj(d) })));
  } while (next);
  return all;
}

function fN(n) { return new Intl.NumberFormat("es-ES").format(n || 0); }

function parseFecha(f) {
  if (!f) return null; let d = null;
  if (typeof f === "string" && f.includes("/")) {
    const p = f.split("/"); if (p.length === 3) { let y = parseInt(p[2]); if (y < 100) y += 2000; d = new Date(y, parseInt(p[1])-1, parseInt(p[0])); }
  } else if (typeof f === "string") d = new Date(f);
  else if (typeof f === "number") d = new Date(f);
  return d && !isNaN(d.getTime()) ? d : null;
}

function esHoy(item) {
  const hoy = new Date();
  const hoyStr = `${hoy.getDate()}/${hoy.getMonth()+1}/${hoy.getFullYear()}`;
  for (const k of ["fecha","fechaCreacion","creadoEn","creadaEn"]) {
    const d = parseFecha(item[k]);
    if (d && d.getDate() === hoy.getDate() && d.getMonth() === hoy.getMonth() && d.getFullYear() === hoy.getFullYear()) return true;
  }
  return false;
}

function esAyer(item) {
  const ayer = new Date(); ayer.setDate(ayer.getDate() - 1);
  for (const k of ["fecha","fechaCreacion","creadoEn","creadaEn"]) {
    const d = parseFecha(item[k]);
    if (d && d.getDate() === ayer.getDate() && d.getMonth() === ayer.getMonth() && d.getFullYear() === ayer.getFullYear()) return true;
  }
  return false;
}

// Departamentos config
const DEPS = {
  calidad:        { label: "Calidad",        icon: "⚠️", color: "#F59E0B", colorBg: "#FEF3C7" },
  logistica:      { label: "Logística",      icon: "🚚", color: "#0EA5E9", colorBg: "#E0F2FE" },
  produccion:     { label: "Producción",     icon: "🏭", color: "#059669", colorBg: "#D1FAE5" },
  administracion: { label: "Administración", icon: "📄", color: "#8B5CF6", colorBg: "#EDE9FE" },
  stock:          { label: "Stock",          icon: "📦", color: "#EF4444", colorBg: "#FEE2E2" },
  id:             { label: "I+D",            icon: "🔬", color: "#7C3AED", colorBg: "#F3E8FF" },
};

const PRIORIDAD_COLOR = { alta: "#EF4444", urgente: "#EF4444", media: "#F59E0B", baja: "#22C55E", normal: "#64748B" };
const ESTADO_ICON = { abierta: "🔴", en_proceso: "🟡", escalada: "🟠", resuelta: "✅", cerrada: "⬜" };

function buildEmailDept({ depKey, depConfig, nombre, incAyer, incNuevasAyer, incResueltasAyer, incPendientes, incEscaladas, tareasHoy, tareasVencidas, muestrasID, muestrasKOAyer, hitosAbiertos, proyectosActivos }) {
  const fD = d => d.toLocaleDateString("es-ES", { weekday: "long", day: "2-digit", month: "short" });
  const hoy = new Date();
  const ayer = new Date(); ayer.setDate(ayer.getDate() - 1);

  const kpi = (n, label, color) => `<div style="flex:1;min-width:70px;background:${color}15;border-radius:10px;padding:10px;text-align:center"><p style="margin:0;font-size:22px;font-weight:800;color:${color}">${n}</p><p style="margin:0;font-size:10px;color:#64748B">${label}</p></div>`;

  const renderInc = (inc) => {
    const pColor = PRIORIDAD_COLOR[inc.prioridad] || "#64748B";
    const eIcon = ESTADO_ICON[inc.estado] || "⚪";
    return `<div style="border-left:3px solid ${pColor};padding:8px 0 8px 12px;margin-bottom:8px;background:#FAFAFA;border-radius:0 8px 8px 0">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px">
        <p style="margin:0;font-size:13px;font-weight:600;color:#0F172A">${eIcon} ${inc.clienteNombre || inc.cliente || "—"}</p>
        <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:6px;background:${pColor}15;color:${pColor}">${(inc.prioridad || "normal").toUpperCase()}</span>
      </div>
      ${inc.subtipo ? `<p style="margin:2px 0 0;font-size:11px;color:${depConfig.color};font-weight:600">${inc.subtipo}</p>` : ""}
      ${inc.descripcion ? `<p style="margin:3px 0 0;font-size:11px;color:#475569;line-height:1.4">${inc.descripcion.substring(0, 200)}${inc.descripcion.length > 200 ? "..." : ""}</p>` : ""}
      <p style="margin:3px 0 0;font-size:10px;color:#94A3B8">${inc.fecha || ""} · Reportada por ${inc.creadoPorNombre || inc.creadoPor || inc.agente || "—"}</p>
    </div>`;
  };

  let html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#F0F4F8;padding:16px;color:#0F172A">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,${depConfig.color},${depConfig.color}CC);color:#fff;padding:24px 20px">
      <p style="margin:0;font-size:13px;opacity:.8">${depConfig.icon} Informe diario · ${fD(hoy)}</p>
      <h1 style="margin:6px 0 0;font-size:22px">${depConfig.label}</h1>
    </div>
    <div style="padding:20px">
    <p style="margin:0 0 16px;font-size:15px">Buenos días <b>${nombre}</b>, aquí tienes tu resumen:</p>`;

  // KPIs
  html += `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:18px">
    ${kpi(incNuevasAyer.length, "Nuevas ayer", depConfig.color)}
    ${kpi(incResueltasAyer.length, "Resueltas ayer", "#22C55E")}
    ${kpi(incPendientes.length, "Pendientes", "#F59E0B")}
    ${kpi(incEscaladas.length, "Escaladas", "#EF4444")}
  </div>`;

  // Nuevas de ayer
  if (incNuevasAyer.length > 0) {
    html += `<p style="margin:18px 0 8px;font-size:14px;font-weight:800;color:${depConfig.color};border-bottom:2px solid #E2E8F0;padding-bottom:6px">🆕 Nuevas de ayer (${incNuevasAyer.length})</p>`;
    incNuevasAyer.forEach(i => { html += renderInc(i); });
  }

  // Resueltas ayer
  if (incResueltasAyer.length > 0) {
    html += `<p style="margin:18px 0 8px;font-size:14px;font-weight:800;color:#22C55E;border-bottom:2px solid #E2E8F0;padding-bottom:6px">✅ Resueltas ayer (${incResueltasAyer.length})</p>`;
    incResueltasAyer.forEach(i => { html += renderInc(i); });
  }

  // Pendientes (backlog)
  if (incPendientes.length > 0) {
    const urgentes = incPendientes.filter(i => i.prioridad === "alta" || i.prioridad === "urgente");
    html += `<p style="margin:18px 0 8px;font-size:14px;font-weight:800;color:#F59E0B;border-bottom:2px solid #E2E8F0;padding-bottom:6px">⏳ Pendientes (${incPendientes.length}${urgentes.length > 0 ? " · " + urgentes.length + " urgentes" : ""})</p>`;
    // Mostrar urgentes primero, luego el resto (max 15)
    const sorted = [...urgentes, ...incPendientes.filter(i => i.prioridad !== "alta" && i.prioridad !== "urgente")];
    sorted.slice(0, 15).forEach(i => { html += renderInc(i); });
    if (sorted.length > 15) html += `<p style="font-size:12px;color:#94A3B8;margin:6px 0">... y ${sorted.length - 15} más</p>`;
  }

  // Escaladas
  if (incEscaladas.length > 0) {
    html += `<p style="margin:18px 0 8px;font-size:14px;font-weight:800;color:#EF4444;border-bottom:2px solid #E2E8F0;padding-bottom:6px">🔺 Escaladas a ti (${incEscaladas.length})</p>`;
    incEscaladas.forEach(i => { html += renderInc(i); });
  }

  // Tareas
  if (tareasHoy.length > 0 || tareasVencidas.length > 0) {
    html += `<p style="margin:18px 0 8px;font-size:14px;font-weight:800;color:#1E3A5F;border-bottom:2px solid #E2E8F0;padding-bottom:6px">📋 Tareas</p>`;
    if (tareasVencidas.length > 0) {
      html += `<p style="margin:6px 0 4px;font-size:12px;font-weight:700;color:#EF4444">🔴 Vencidas (${tareasVencidas.length})</p>`;
      tareasVencidas.forEach(t => {
        html += `<div style="padding:4px 0 4px 10px;margin-bottom:4px;border-left:3px solid #EF4444"><p style="margin:0;font-size:12px"><b>${t.titulo}</b> <span style="color:#64748B">· vence ${t.vence || "?"} · ${t.cliente || ""}</span></p></div>`;
      });
    }
    if (tareasHoy.length > 0) {
      html += `<p style="margin:6px 0 4px;font-size:12px;font-weight:700;color:#1E3A5F">📌 Para hoy (${tareasHoy.length})</p>`;
      tareasHoy.forEach(t => {
        html += `<div style="padding:4px 0 4px 10px;margin-bottom:4px;border-left:3px solid #3B82F6"><p style="margin:0;font-size:12px"><b>${t.titulo}</b> <span style="color:#64748B">· ${t.cliente || ""}</span></p></div>`;
      });
    }
  }

  // Muestras pendientes feedback (I+D)
  if (muestrasID && muestrasID.length > 0) {
    html += `<p style="margin:18px 0 8px;font-size:14px;font-weight:800;color:#7C3AED;border-bottom:2px solid #E2E8F0;padding-bottom:6px">🔬 Muestras pendientes feedback (${muestrasID.length})</p>`;
    muestrasID.slice(0, 10).forEach(m => {
      html += `<div style="padding:4px 0 4px 10px;margin-bottom:4px;border-left:3px solid #7C3AED"><p style="margin:0;font-size:12px"><b>${m.cliente || "—"}</b> — ${m.prod || m.tipo || "?"} · ${m.estadoMuestra||"?"} <span style="color:#64748B">(${m.agente || ""})</span></p></div>`;
    });
    if (muestrasID.length > 10) html += `<p style="font-size:11px;color:#94A3B8">... y ${muestrasID.length-10} más</p>`;
  }

  // Muestras KO de ayer (I+D)
  if (muestrasKOAyer && muestrasKOAyer.length > 0) {
    html += `<p style="margin:18px 0 8px;font-size:14px;font-weight:800;color:#EF4444;border-bottom:2px solid #E2E8F0;padding-bottom:6px">❌ Muestras KO ayer (${muestrasKOAyer.length})</p>`;
    muestrasKOAyer.forEach(m => {
      html += `<div style="border-left:3px solid #EF4444;padding:6px 0 6px 10px;margin-bottom:6px;background:#FEF2F2;border-radius:0 6px 6px 0">
        <p style="margin:0;font-size:12px;font-weight:600;color:#991B1B">${m.cliente||"—"} — ${m.prod||m.tipo||"?"}</p>
        ${m.motivo?`<p style="margin:2px 0 0;font-size:11px;color:#DC2626">Motivo: ${m.motivo}</p>`:""}
        ${m.nota?`<p style="margin:2px 0 0;font-size:11px;color:#475569;font-style:italic">"${m.nota.substring(0,200)}"</p>`:""}
        <p style="margin:2px 0 0;font-size:10px;color:#94A3B8">${m.agente||""} · ${m.equipo||""}</p>
      </div>`;
    });
  }

  // Proyectos activos (I+D)
  if (proyectosActivos && proyectosActivos.length > 0) {
    html += `<p style="margin:18px 0 8px;font-size:14px;font-weight:800;color:#3B82F6;border-bottom:2px solid #E2E8F0;padding-bottom:6px">🚀 Proyectos activos (${proyectosActivos.length})</p>`;
    proyectosActivos.forEach(p => {
      const pc = p.progreso >= 75 ? "#22C55E" : p.progreso >= 40 ? "#F59E0B" : "#3B82F6";
      html += `<div style="background:#F8FAFC;border-radius:8px;padding:8px 12px;margin-bottom:6px;border-left:3px solid ${pc}">
        <div style="display:flex;justify-content:space-between"><b style="font-size:12px;color:#1E3A5F">${p.nombre}</b><span style="font-size:12px;font-weight:800;color:${pc}">${p.progreso}%</span></div>
        <p style="margin:2px 0 0;font-size:10px;color:#64748B">${p.hitosHechos}/${p.totalHitos} hitos</p>
        <div style="background:#E2E8F0;border-radius:3px;height:4px;margin-top:4px"><div style="background:${pc};height:100%;width:${p.progreso}%;border-radius:3px"></div></div>
      </div>`;
    });
  }

  // Hitos pendientes (I+D)
  if (hitosAbiertos && hitosAbiertos.length > 0) {
    html += `<p style="margin:18px 0 8px;font-size:14px;font-weight:800;color:#F59E0B;border-bottom:2px solid #E2E8F0;padding-bottom:6px">🏗️ Hitos pendientes (${hitosAbiertos.length})</p>`;
    hitosAbiertos.slice(0,15).forEach(h => {
      const hoyISO = new Date().toISOString().split("T")[0];
      const fISO = h.fecha.includes("/") ? h.fecha.split("/").reverse().join("-") : h.fecha;
      const venc = fISO && fISO < hoyISO;
      html += `<div style="padding:3px 0 3px 10px;margin-bottom:3px;border-left:3px solid ${venc?"#EF4444":"#F59E0B"}"><p style="margin:0;font-size:11px">${venc?"🔴":"🟡"} <b>${h.nombre}</b> · ${h.proyecto} · ${h.fecha||"sin fecha"}</p></div>`;
    });
  }

  // Sin actividad
  if (incNuevasAyer.length === 0 && incResueltasAyer.length === 0 && incPendientes.length === 0 && tareasHoy.length === 0 && tareasVencidas.length === 0) {
    html += `<div style="text-align:center;padding:24px"><p style="font-size:40px;margin:0">✨</p><p style="margin:8px 0 0;font-size:14px;color:#22C55E;font-weight:700">Todo al día — sin incidencias pendientes</p></div>`;
  }

  html += `<p style="margin:24px 0 0;text-align:center"><a href="https://crmwikuk.vercel.app" style="display:inline-block;background:${depConfig.color};color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">Abrir CRM</a></p>
    <p style="margin:20px 0 0;font-size:10px;color:#94A3B8;text-align:center">Grupo Consolidado · ${depConfig.label} · ${fD(hoy)}</p>
    </div></div></body></html>`;
  return html;
}

// ══════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════
export default async function handler(req, res) {
  const isManual = req.query && req.query.manual === "1";
  const isCron = req.headers["user-agent"] && req.headers["user-agent"].includes("vercel-cron");
  if (!isManual && !isCron) return res.status(401).json({ ok: false, error: "Solo via cron o ?manual=1" });

  try {
    const [usuarios, incidencias, tareas, muestras, proyectos] = await Promise.all([
      fbList("usuarios"), fbList("incidencias"), fbList("tareas"), fbList("muestras"), fbList("proyectos"),
    ]);

    const noElim = arr => arr.filter(x => !x.eliminada);
    const allInc = noElim(incidencias);
    const allTareas = noElim(tareas);
    const allMuestras = noElim(muestras);
    const allProyectos = noElim(proyectos).filter(p => p.estado === "activo");
    const hoy = new Date();

    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    const sent = [], errors = [];

    // Responsables de departamento
    const responsables = usuarios.filter(u => u.rol === "tipologia" && u.email && u.tipologia);

    for (const resp of responsables) {
      const depKey = resp.tipologia;
      const depConfig = DEPS[depKey];
      if (!depConfig) continue;

      // Incidencias de este departamento
      const incDep = allInc.filter(i => i.tipo === depKey);

      // Nuevas de ayer
      const incNuevasAyer = incDep.filter(i => esAyer(i) && i.estado !== "resuelta" && i.estado !== "cerrada");

      // Resueltas ayer (por fecha de resolución o por estado + fecha)
      const incResueltasAyer = incDep.filter(i => {
        if (i.estado !== "resuelta" && i.estado !== "cerrada") return false;
        const fRes = parseFecha(i.fechaResolucion || i.fechaCierre);
        if (fRes) {
          const ayer = new Date(); ayer.setDate(ayer.getDate() - 1);
          return fRes.getDate() === ayer.getDate() && fRes.getMonth() === ayer.getMonth();
        }
        return esAyer(i);
      });

      // Pendientes (abierta, en_proceso)
      const incPendientes = incDep.filter(i => i.estado !== "resuelta" && i.estado !== "cerrada");

      // Escaladas a este responsable
      const incEscaladas = allInc.filter(i => !i.eliminada && i.escaladoA === resp.id && i.estado !== "resuelta" && i.estado !== "cerrada");

      // Tareas asignadas a este responsable
      const misTareas = allTareas.filter(t => t.agente === resp.id && t.estado !== "completada" && t.estado !== "cerrada");
      const tareasHoy = misTareas.filter(t => {
        const v = parseFecha(t.vence);
        return v && v.getDate() === hoy.getDate() && v.getMonth() === hoy.getMonth() && v.getFullYear() === hoy.getFullYear();
      });
      const tareasVencidas = misTareas.filter(t => {
        const v = parseFecha(t.vence);
        return v && v < hoy && !(v.getDate() === hoy.getDate() && v.getMonth() === hoy.getMonth());
      });

      // Muestras (solo I+D)
      let muestrasID = null, muestrasKOAyer = null, hitosAbiertos = null, proyectosActivos = null;
      if (depKey === "id") {
        muestrasID = allMuestras.filter(m => !m.fechaFeedback && (m.estadoMuestra === "ENTREGADO" || m.estadoMuestra === "ENVIADO"));
        muestrasKOAyer = allMuestras.filter(m => m.estado === "ko" && esAyer(m));
        hitosAbiertos = [];
        allProyectos.forEach(p => {
          (p.hitos || []).forEach(h => {
            if (typeof h !== "object" || !h || h.hecho) return;
            hitosAbiertos.push({ nombre: h.nombre || "Sin nombre", proyecto: p.nombre || "", fecha: h.fecha || "", responsable: h.responsable || "" });
          });
        });
        proyectosActivos = allProyectos.map(p => {
          const hitos = (p.hitos || []).filter(h => typeof h === "object" && h);
          const hechos = hitos.filter(h => h.hecho).length;
          return { nombre: p.nombre || "", progreso: hitos.length > 0 ? Math.round(hechos / hitos.length * 100) : 0, totalHitos: hitos.length, hitosHechos: hechos };
        });
      }

      const html = buildEmailDept({
        depKey, depConfig,
        nombre: resp.nombre,
        incAyer: incDep.filter(i => esAyer(i)),
        incNuevasAyer,
        incResueltasAyer,
        incPendientes,
        incEscaladas,
        tareasHoy,
        tareasVencidas,
        muestrasID, muestrasKOAyer, hitosAbiertos, proyectosActivos,
      });

      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: resp.email,
          subject: `${depConfig.icon} ${depConfig.label} · Informe diario ${hoy.toLocaleDateString("es-ES")}`,
          html,
        });
        sent.push({ dept: depKey, nombre: resp.nombre, email: resp.email });
      } catch (err) {
        errors.push({ dept: depKey, email: resp.email, error: err.message });
      }
    }

    return res.status(200).json({
      ok: true,
      fecha: hoy.toISOString(),
      departamentos: responsables.map(r => r.tipologia),
      sent, errors,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, stack: err.stack });
  }
}
