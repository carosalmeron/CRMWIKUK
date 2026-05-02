// /api/weekly-dept.js
// Cron: viernes 17:05 UTC (19:05 CEST)
// 1) Informe semanal a cada responsable de departamento
// 2) Informe consolidado CEO de todos los departamentos operativos

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

function getSemanaISO(d = new Date()) {
  const t = new Date(d.valueOf()), dn = (d.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dn + 3);
  const ft = t.valueOf(); t.setUTCMonth(0, 1);
  if (t.getUTCDay() !== 4) t.setUTCMonth(0, 1 + ((4 - t.getUTCDay()) + 7) % 7);
  return 1 + Math.ceil((ft - t) / 604800000);
}
function rangeWeek() {
  const h = new Date(), off = (h.getDay() || 7) - 1;
  const lu = new Date(h); lu.setDate(h.getDate() - off); lu.setHours(0,0,0,0);
  const vi = new Date(lu); vi.setDate(lu.getDate() + 4); vi.setHours(23,59,59,999);
  return { lu, vi };
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
function enSemana(item, sem, lu, vi) {
  if (item.semana !== undefined && item.semana !== null && item.semana !== "") { const s = parseInt(item.semana); if (!isNaN(s)) return s === sem; }
  for (const k of ["fecha","fechaCreacion","creadoEn","creadaEn","fechaResolucion","fechaCierre"]) { const d = parseFecha(item[k]); if (d && d >= lu && d <= vi) return true; }
  return false;
}

const DIAS = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
function diaKey(fecha) { const d = parseFecha(fecha); if (!d) return "Sin fecha"; return `${DIAS[d.getDay()]} ${d.getDate()}/${d.getMonth()+1}`; }
function groupByDay(items) {
  const g = {}, order = ["Lunes","Martes","Miércoles","Jueves","Viernes"];
  items.forEach(i => { const dk = diaKey(i.fecha||i.fechaCreacion||i.creadoEn); if (!g[dk]) g[dk] = []; g[dk].push(i); });
  const s = {}, ks = Object.keys(g).sort((a,b) => { const da=order.findIndex(d=>a.startsWith(d)),db=order.findIndex(d=>b.startsWith(d)); return (da===-1?99:da)-(db===-1?99:db); });
  ks.forEach(k => s[k] = g[k]); return s;
}

const DEPS = {
  calidad:        { label:"Calidad",        icon:"⚠️",  color:"#F59E0B" },
  logistica:      { label:"Logística",      icon:"🚚", color:"#0EA5E9" },
  produccion:     { label:"Producción",     icon:"🏭", color:"#059669" },
  administracion: { label:"Administración", icon:"📄", color:"#8B5CF6" },
  stock:          { label:"Stock",          icon:"📦", color:"#EF4444" },
  id:             { label:"I+D",            icon:"🔬", color:"#7C3AED" },
};
const PRIO_C = { alta:"#EF4444", urgente:"#EF4444", media:"#F59E0B", baja:"#22C55E", normal:"#64748B" };
const EST_I = { abierta:"🔴", en_proceso:"🟡", escalada:"🟠", resuelta:"✅", cerrada:"⬜" };

function kpi(n,l,c) { return `<div style="flex:1;min-width:70px;background:${c}15;border-radius:10px;padding:10px;text-align:center"><p style="margin:0;font-size:22px;font-weight:800;color:${c}">${n}</p><p style="margin:0;font-size:10px;color:#64748B">${l}</p></div>`; }
function dayHdr(d) { return `<div style="background:#475569;color:#fff;padding:5px 10px;border-radius:6px;margin:10px 0 6px;font-size:11px;font-weight:700">${d}</div>`; }

function renderInc(i, dc) {
  const pc = PRIO_C[i.prioridad]||"#64748B", ei = EST_I[i.estado]||"⚪";
  return `<div style="border-left:3px solid ${pc};padding:6px 0 6px 10px;margin-bottom:6px;background:#FAFAFA;border-radius:0 6px 6px 0">
    <p style="margin:0;font-size:12px;font-weight:600">${ei} ${i.clienteNombre||i.cliente||"—"} <span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:${pc}15;color:${pc}">${(i.prioridad||"normal").toUpperCase()}</span></p>
    ${i.subtipo?`<p style="margin:1px 0 0;font-size:10px;color:${dc.color};font-weight:600">${i.subtipo}</p>`:""}
    ${i.descripcion?`<p style="margin:2px 0 0;font-size:11px;color:#475569">${i.descripcion.substring(0,150)}${i.descripcion.length>150?"...":""}</p>`:""}
    <p style="margin:2px 0 0;font-size:10px;color:#94A3B8">${i.fecha||""} · ${i.creadoPorNombre||i.creadoPor||i.agente||""}</p>
  </div>`;
}

// ── Email departamento semanal ──
function buildWeeklyDept({ depConfig, nombre, semana, lu, vi, nuevas, resueltas, pendientes, escaladas, tareasCompletadas, tareasPendientes, muestrasID, muestrasKO, hitosAbiertos, proyectosActivos }) {
  const fD = d => d.toLocaleDateString("es-ES", { day:"2-digit", month:"short" });
  let html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#F0F4F8;padding:16px;color:#0F172A">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,${depConfig.color},${depConfig.color}CC);color:#fff;padding:24px 20px">
      <p style="margin:0;font-size:13px;opacity:.8">${depConfig.icon} Resumen semanal · Semana ${semana}</p>
      <h1 style="margin:6px 0 0;font-size:22px">${depConfig.label}</h1>
      <p style="margin:6px 0 0;font-size:13px;opacity:.8">${fD(lu)} → ${fD(vi)}</p>
    </div>
    <div style="padding:20px">
    <p style="margin:0 0 16px;font-size:15px">Hola <b>${nombre}</b>, aquí tienes tu cierre de semana:</p>`;

  html += `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:18px">
    ${kpi(nuevas.length,"Nuevas",depConfig.color)}
    ${kpi(resueltas.length,"Resueltas","#22C55E")}
    ${kpi(pendientes.length,"Pendientes","#F59E0B")}
    ${kpi(escaladas.length,"Escaladas","#EF4444")}
    ${kpi(tareasCompletadas.length,"Tareas OK","#3B82F6")}
  </div>`;

  // Nuevas por día
  if (nuevas.length > 0) {
    html += `<p style="margin:18px 0 8px;font-size:14px;font-weight:800;color:${depConfig.color}">🆕 Nuevas de la semana (${nuevas.length})</p>`;
    const byD = groupByDay(nuevas);
    Object.keys(byD).forEach(d => { html += dayHdr(d); byD[d].forEach(i => { html += renderInc(i, depConfig); }); });
  }

  // Resueltas
  if (resueltas.length > 0) {
    html += `<p style="margin:18px 0 8px;font-size:14px;font-weight:800;color:#22C55E">✅ Resueltas (${resueltas.length})</p>`;
    resueltas.forEach(i => { html += renderInc(i, depConfig); });
  }

  // Pendientes
  if (pendientes.length > 0) {
    const urg = pendientes.filter(i => i.prioridad==="alta"||i.prioridad==="urgente");
    html += `<p style="margin:18px 0 8px;font-size:14px;font-weight:800;color:#F59E0B">⏳ Pendientes (${pendientes.length}${urg.length>0?" · "+urg.length+" urgentes":""})</p>`;
    const sorted = [...urg, ...pendientes.filter(i => i.prioridad!=="alta"&&i.prioridad!=="urgente")];
    sorted.slice(0,20).forEach(i => { html += renderInc(i, depConfig); });
    if (sorted.length > 20) html += `<p style="font-size:11px;color:#94A3B8;margin:6px 0">... y ${sorted.length-20} más</p>`;
  }

  // Muestras I+D — pendientes feedback
  if (muestrasID && muestrasID.length > 0) {
    html += `<p style="margin:18px 0 8px;font-size:14px;font-weight:800;color:#7C3AED">🔬 Muestras pendientes feedback (${muestrasID.length})</p>`;
    muestrasID.slice(0,10).forEach(m => {
      html += `<div style="padding:3px 0 3px 10px;margin-bottom:3px;border-left:3px solid #7C3AED"><p style="margin:0;font-size:12px"><b>${m.cliente||"—"}</b> — ${m.prod||m.tipo||"?"} · ${m.estadoMuestra||"?"} <span style="color:#64748B">(${m.agente||""})</span></p></div>`;
    });
  }

  // Muestras KO de la semana con comentarios
  if (muestrasKO && muestrasKO.length > 0) {
    html += `<p style="margin:18px 0 8px;font-size:14px;font-weight:800;color:#EF4444">❌ Muestras KO esta semana (${muestrasKO.length})</p>`;
    muestrasKO.forEach(m => {
      html += `<div style="border-left:3px solid #EF4444;padding:8px 0 8px 12px;margin-bottom:8px;background:#FEF2F2;border-radius:0 8px 8px 0">
        <p style="margin:0;font-size:13px;font-weight:600;color:#991B1B">${m.cliente||"—"} — ${m.prod||m.tipo||"?"}</p>
        <p style="margin:2px 0 0;font-size:11px;color:#64748B">${m.agente||""} · ${m.fecha||""} · ${m.equipo||""}</p>
        ${m.motivo?`<p style="margin:4px 0 0;font-size:12px;color:#DC2626;font-weight:600">Motivo: ${m.motivo}</p>`:""}
        ${m.nota?`<p style="margin:3px 0 0;font-size:11px;color:#475569;font-style:italic;line-height:1.4">"${m.nota.substring(0,250)}${m.nota.length>250?"...":""}"</p>`:""}
      </div>`;
    });
  }

  // Proyectos activos
  if (proyectosActivos && proyectosActivos.length > 0) {
    html += `<p style="margin:18px 0 8px;font-size:14px;font-weight:800;color:#3B82F6">🚀 Proyectos activos (${proyectosActivos.length})</p>`;
    proyectosActivos.forEach(p => {
      const pctColor = p.progreso >= 75 ? "#22C55E" : p.progreso >= 40 ? "#F59E0B" : "#3B82F6";
      html += `<div style="background:#F8FAFC;border-radius:8px;padding:10px 14px;margin-bottom:8px;border-left:3px solid ${pctColor}">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <p style="margin:0;font-size:13px;font-weight:700;color:#1E3A5F">${p.nombre}</p>
          <span style="font-size:13px;font-weight:800;color:${pctColor}">${p.progreso}%</span>
        </div>
        <p style="margin:3px 0 0;font-size:11px;color:#64748B">${p.tipo||""} · ${p.hitosHechos}/${p.totalHitos} hitos · ${p.responsable}</p>
        <div style="background:#E2E8F0;border-radius:4px;height:6px;margin-top:6px;overflow:hidden"><div style="background:${pctColor};height:100%;width:${p.progreso}%;border-radius:4px"></div></div>
      </div>`;
    });
  }

  // Hitos abiertos pendientes
  if (hitosAbiertos && hitosAbiertos.length > 0) {
    html += `<p style="margin:18px 0 8px;font-size:14px;font-weight:800;color:#F59E0B">🏗️ Hitos pendientes (${hitosAbiertos.length})</p>`;
    hitosAbiertos.slice(0,20).forEach(h => {
      const hoy = new Date().toISOString().split("T")[0];
      const fISO = h.fecha.includes("/") ? h.fecha.split("/").reverse().join("-") : h.fecha;
      const vencido = fISO && fISO < hoy;
      html += `<div style="padding:4px 0 4px 10px;margin-bottom:4px;border-left:3px solid ${vencido?"#EF4444":"#F59E0B"}">
        <p style="margin:0;font-size:12px">${vencido?"🔴":"🟡"} <b>${h.nombre}</b> <span style="color:#64748B">· ${h.proyecto} · ${h.fecha||"sin fecha"} · ${h.responsable||""}</span></p>
      </div>`;
    });
    if (hitosAbiertos.length > 20) html += `<p style="font-size:11px;color:#94A3B8;margin:6px 0">... y ${hitosAbiertos.length-20} más</p>`;
  }

  if (nuevas.length===0 && resueltas.length===0 && pendientes.length===0) {
    html += `<div style="text-align:center;padding:24px"><p style="font-size:40px;margin:0">✨</p><p style="margin:8px 0 0;font-size:14px;color:#22C55E;font-weight:700">Semana limpia — sin incidencias</p></div>`;
  }

  html += `<p style="margin:24px 0 0;text-align:center"><a href="https://crmwikuk.vercel.app" style="display:inline-block;background:${depConfig.color};color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">Abrir CRM</a></p>
    <p style="margin:20px 0 0;font-size:10px;color:#94A3B8;text-align:center">Grupo Consolidado · ${depConfig.label} · Semana ${semana}</p>
    </div></div></body></html>`;
  return html;
}

// ── Email CEO consolidado ──
function buildCEOConsolidado({ semana, lu, vi, nombre, depData }) {
  const fD = d => d.toLocaleDateString("es-ES", { day:"2-digit", month:"short" });
  let totalN=0,totalR=0,totalP=0,totalE=0;
  depData.forEach(d => { totalN+=d.nuevas; totalR+=d.resueltas; totalP+=d.pendientes; totalE+=d.escaladas; });

  let html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#F0F4F8;padding:16px;color:#0F172A">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#0F172A,#334155);color:#fff;padding:24px 20px">
      <p style="margin:0;font-size:13px;opacity:.8">📊 Semana ${semana} · ${fD(lu)} → ${fD(vi)}</p>
      <h1 style="margin:6px 0 0;font-size:22px">Consolidado Departamentos</h1>
    </div>
    <div style="padding:20px">
    <p style="margin:0 0 16px;font-size:15px">Hola <b>${nombre}</b>, resumen operativo de la semana:</p>`;

  // Totales
  html += `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:18px">
    ${kpi(totalN,"Nuevas","#1E3A5F")}${kpi(totalR,"Resueltas","#22C55E")}${kpi(totalP,"Pendientes","#F59E0B")}${kpi(totalE,"Escaladas","#EF4444")}
  </div>`;

  // Por departamento
  html += `<p style="margin:18px 0 10px;font-size:15px;font-weight:800;color:#1E3A5F;border-bottom:2px solid #E2E8F0;padding-bottom:6px">Por departamento</p>`;
  depData.forEach(d => {
    const dc = DEPS[d.key] || { label: d.key, icon: "📋", color: "#64748B" };
    const tasaRes = d.nuevas + d.resueltas > 0 ? Math.round(d.resueltas / (d.nuevas + d.resueltas) * 100) : null;
    const tasaC = tasaRes === null ? "#94A3B8" : tasaRes >= 80 ? "#22C55E" : tasaRes >= 50 ? "#F59E0B" : "#EF4444";

    html += `<div style="background:#F8FAFC;border-radius:10px;padding:14px;margin-bottom:10px;border-left:4px solid ${dc.color}">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px">
        <p style="margin:0;font-weight:700;font-size:14px;color:#1E3A5F">${dc.icon} ${dc.label}</p>
        ${tasaRes !== null ? `<span style="font-size:12px;font-weight:700;color:${tasaC}">${tasaRes}% resolución</span>` : ""}
      </div>
      <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
        <span style="font-size:11px;padding:3px 8px;border-radius:6px;background:${dc.color}15;color:${dc.color};font-weight:700">${d.nuevas} nuevas</span>
        <span style="font-size:11px;padding:3px 8px;border-radius:6px;background:#DCFCE7;color:#166534;font-weight:700">${d.resueltas} resueltas</span>
        <span style="font-size:11px;padding:3px 8px;border-radius:6px;background:#FEF3C7;color:#92400E;font-weight:700">${d.pendientes} pendientes</span>
        ${d.escaladas > 0 ? `<span style="font-size:11px;padding:3px 8px;border-radius:6px;background:#FEE2E2;color:#991B1B;font-weight:700">${d.escaladas} escaladas</span>` : ""}
      </div>
      ${d.urgentes > 0 ? `<p style="margin:6px 0 0;font-size:11px;color:#EF4444;font-weight:700">🔴 ${d.urgentes} urgente${d.urgentes>1?"s":""} pendiente${d.urgentes>1?"s":""}</p>` : ""}
    </div>`;
  });

  // Alertas críticas (urgentes sin resolver de cualquier depto)
  const alertas = depData.filter(d => d.urgentes > 0);
  if (alertas.length > 0) {
    html += `<p style="margin:18px 0 10px;font-size:15px;font-weight:800;color:#EF4444;border-bottom:2px solid #E2E8F0;padding-bottom:6px">🚨 Alertas críticas</p>`;
    alertas.forEach(d => {
      const dc = DEPS[d.key] || { label: d.key, icon: "📋", color: "#64748B" };
      d.urgList.forEach(i => {
        html += `<div style="border-left:3px solid #EF4444;padding:5px 0 5px 10px;margin-bottom:5px"><p style="margin:0;font-size:12px"><b>${dc.icon} ${i.clienteNombre||i.cliente||"—"}</b> — ${i.subtipo||i.descripcion||"?"} <span style="color:#94A3B8">(${i.fecha||""})</span></p></div>`;
      });
    });
  }

  html += `<p style="margin:24px 0 0;text-align:center"><a href="https://crmwikuk.vercel.app" style="display:inline-block;background:#1E3A5F;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">Abrir CRM</a></p>
    <p style="margin:20px 0 0;font-size:10px;color:#94A3B8;text-align:center">Grupo Consolidado · Consolidado operativo · Semana ${semana}</p>
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
    const semana = getSemanaISO();
    const { lu, vi } = rangeWeek();

    const [usuarios, incidencias, tareas, muestras, proyectos] = await Promise.all([
      fbList("usuarios"), fbList("incidencias"), fbList("tareas"), fbList("muestras"), fbList("proyectos"),
    ]);

    const noElim = arr => arr.filter(x => !x.eliminada);
    const allInc = noElim(incidencias);
    const allTareas = noElim(tareas);
    const allMuestras = noElim(muestras);
    const allProyectos = noElim(proyectos).filter(p => p.estado === "activo");

    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    const sent = [], errors = [];

    // Data por departamento (para CEO también)
    const depDataAll = [];

    const responsables = usuarios.filter(u => u.rol === "tipologia" && u.email && u.tipologia);

    for (const resp of responsables) {
      const depKey = resp.tipologia;
      const depConfig = DEPS[depKey];
      if (!depConfig) continue;

      const incDep = allInc.filter(i => i.tipo === depKey);
      const nuevas = incDep.filter(i => enSemana(i, semana, lu, vi) && i.estado !== "resuelta" && i.estado !== "cerrada");
      const resueltas = incDep.filter(i => (i.estado === "resuelta" || i.estado === "cerrada") && enSemana(i, semana, lu, vi));
      const pendientes = incDep.filter(i => i.estado !== "resuelta" && i.estado !== "cerrada");
      const escaladas = allInc.filter(i => i.escaladoA === resp.id && i.estado !== "resuelta" && i.estado !== "cerrada");
      const urgentes = pendientes.filter(i => i.prioridad === "alta" || i.prioridad === "urgente");

      const misTareas = allTareas.filter(t => t.agente === resp.id);
      const tareasCompletadas = misTareas.filter(t => (t.estado === "completada" || t.estado === "cerrada") && enSemana(t, semana, lu, vi));
      const tareasPendientes = misTareas.filter(t => t.estado !== "completada" && t.estado !== "cerrada");

      let muestrasID = null, muestrasKO = null, hitosAbiertos = null, proyectosActivos = null;
      if (depKey === "id") {
        muestrasID = allMuestras.filter(m => !m.fechaFeedback && (m.estadoMuestra === "ENTREGADO" || m.estadoMuestra === "ENVIADO"));
        // Muestras KO de la semana con comentarios
        muestrasKO = allMuestras.filter(m => m.estado === "ko" && enSemana(m, semana, lu, vi));
        // Hitos abiertos de proyectos activos
        hitosAbiertos = [];
        allProyectos.forEach(p => {
          (p.hitos || []).forEach(h => {
            if (typeof h !== "object" || !h || h.hecho) return;
            hitosAbiertos.push({ nombre: h.nombre || "Sin nombre", proyecto: p.nombre || "", fecha: h.fecha || "", responsable: h.responsable || "" });
          });
        });
        // Proyectos activos con progreso
        proyectosActivos = allProyectos.map(p => {
          const hitos = (p.hitos || []).filter(h => typeof h === "object" && h);
          const hechos = hitos.filter(h => h.hecho).length;
          return { nombre: p.nombre || "Sin nombre", tipo: p.tipo || "", progreso: hitos.length > 0 ? Math.round(hechos / hitos.length * 100) : 0, totalHitos: hitos.length, hitosHechos: hechos, responsable: p.responsableNombre || p.responsable || "" };
        });
      }

      depDataAll.push({ key: depKey, nuevas: nuevas.length, resueltas: resueltas.length, pendientes: pendientes.length, escaladas: escaladas.length, urgentes: urgentes.length, urgList: urgentes.slice(0, 5) });

      const html = buildWeeklyDept({ depConfig, nombre: resp.nombre, semana, lu, vi, nuevas, resueltas, pendientes, escaladas, tareasCompletadas, tareasPendientes, muestrasID, muestrasKO, hitosAbiertos, proyectosActivos });

      try {
        await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: resp.email,
          subject: `${depConfig.icon} ${depConfig.label} · Semana ${semana}`, html });
        sent.push({ tipo: "dept", dept: depKey, email: resp.email });
      } catch (err) { errors.push({ tipo: "dept", dept: depKey, error: err.message }); }
    }

    // ── CEO CONSOLIDADO ──
    const ceo = usuarios.find(u => u.rol === "ceo" && u.email);
    if (ceo && depDataAll.length > 0) {
      const html = buildCEOConsolidado({ semana, lu, vi, nombre: ceo.nombre, depData: depDataAll });
      try {
        await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: ceo.email,
          subject: `📊 Consolidado departamentos · Semana ${semana}`, html });
        sent.push({ tipo: "ceo_dept", email: ceo.email });
      } catch (err) { errors.push({ tipo: "ceo_dept", error: err.message }); }
    }

    return res.status(200).json({ ok: true, semana, departamentos: depDataAll, sent, errors });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message, stack: err.stack }); }
}
