// /api/daily-summary.js  —  v1
// Informe DIARIO comercial — basado en weekly-summary.js
//
// Comportamiento:
// - Por defecto envía la actividad del DÍA LABORABLE ANTERIOR
//   · Lun → Viernes anterior · Mar → Lunes · Mié → Martes · Jue → Miércoles · Vie → Jueves
// - Override: ?fecha=YYYY-MM-DD (envía un día concreto)
// - Override: ?dia=hoy (envía la actividad del día actual — útil para el Viernes 19:00)
// - Misma estructura que weekly-summary pero filtrando por UN solo día
// - Mismo filtro de aprobación jerárquica:
//     resp / agente → sin filtro
//     dir → solo aprobadoResp !== false
//     ceo → solo aprobadoResp !== false && aprobadoJefe !== false

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
function mismaFecha(d1, d2) {
  if (!d1 || !d2) return false;
  return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
}
function enFecha(item, fecha) {
  for (const k of ["fecha","fechaCreacion","creadoEn","fechaAlta","creadaEn","fechaHecho"]) {
    const d = parseFecha(item[k]);
    if (d && mismaFecha(d, fecha)) return true;
  }
  return false;
}
function pertA(item, ids) {
  return ids.has(String(item.agente||item.agenteId||item.autor||item.creadoPor||item.responsable||"").toUpperCase());
}

// Día laborable anterior según el día de la semana actual
function diaAnteriorLaborable(d) {
  const day = d.getDay(); // 0=dom, 1=lun, ..., 6=sab
  let offset;
  if (day === 1) offset = -3;       // lun → vie anterior
  else if (day === 0) offset = -2;  // dom → vie
  else if (day === 6) offset = -1;  // sáb → vie
  else offset = -1;                 // mar/mié/jue/vie → día anterior
  const r = new Date(d); r.setDate(d.getDate() + offset); r.setHours(0,0,0,0);
  return r;
}
function fechaDesdeQuery(req) {
  // ?fecha=YYYY-MM-DD → fecha exacta
  // ?dia=hoy → hoy
  // ?dia=ayer → día anterior laborable (= default)
  // sin params → día anterior laborable
  const q = req.query || {};
  if (q.fecha) {
    const partes = q.fecha.split("-");
    if (partes.length === 3) {
      const d = new Date(parseInt(partes[0]), parseInt(partes[1])-1, parseInt(partes[2]));
      if (!isNaN(d.getTime())) { d.setHours(0,0,0,0); return d; }
    }
  }
  if (q.dia === "hoy") {
    const d = new Date(); d.setHours(0,0,0,0); return d;
  }
  return diaAnteriorLaborable(new Date());
}

const DIAS_FULL = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
const MESES = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
function fmtFecha(d) { return `${DIAS_FULL[d.getDay()]} ${d.getDate()} ${MESES[d.getMonth()]}`; }

function getSemanaISO(d = new Date()) {
  const t = new Date(d.valueOf()), dn = (d.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dn + 3);
  const ft = t.valueOf(); t.setUTCMonth(0, 1);
  if (t.getUTCDay() !== 4) t.setUTCMonth(0, 1 + ((4 - t.getUTCDay()) + 7) % 7);
  return 1 + Math.ceil((ft - t) / 604800000);
}

function colorR(r) { return {visitado:"#22C55E",nuevo_pedido:"#16A34A",seguimiento:"#3B82F6",llamada:"#8B5CF6",no_disponible:"#F59E0B",no_compra:"#EF4444",sin_contacto:"#94A3B8"}[r]||"#64748B"; }
function labelR(r) { return {visitado:"Visitado",nuevo_pedido:"Nuevo pedido",seguimiento:"Seguimiento",llamada:"Llamada",no_disponible:"No disponible",no_compra:"No compra",sin_contacto:"Sin contacto"}[r]||(r||"—"); }

// ── HTML helpers ──
const S = { hdr: "margin:24px 0 10px;font-size:15px;font-weight:800;color:#1E3A5F;border-bottom:2px solid #E2E8F0;padding-bottom:6px;" };

function kpiSimple(val, label, color) {
  return `<div style="flex:1;min-width:70px;background:${color}15;border-radius:10px;padding:10px;text-align:center"><p style="margin:0;font-size:20px;font-weight:800;color:${color}">${val}</p><p style="margin:0;font-size:10px;color:#64748B">${label}</p></div>`;
}

function renderVis(v, showAgent, nombreMap) {
  const agName = showAgent ? (nombreMap[String(v.agente||v.agenteId||v.creadoPor||"").toUpperCase()] || v.creadoPorNombre || v.agente || "") : "";
  return `<div style="border-left:3px solid ${colorR(v.resultado)};padding:6px 0 6px 10px;margin-bottom:6px;background:#FAFAFA;border-radius:0 6px 6px 0">
    <p style="margin:0;font-size:13px;font-weight:600;color:#0F172A">${v.clienteNombre||v.cliente||"—"}${showAgent?` <span style="color:#64748B;font-weight:400;font-size:11px">(${agName})</span>`:""}</p>
    <p style="margin:2px 0 0;font-size:11px;color:#64748B"><span style="color:${colorR(v.resultado)};font-weight:600">${labelR(v.resultado)}</span>${v.ciudad?" · "+v.ciudad:""}${v.contacto?" · "+v.contacto:""}</p>
    ${v.nota||v.notas?`<p style="margin:3px 0 0;font-size:11px;color:#475569;line-height:1.4">${(v.nota||v.notas).substring(0,250)}${(v.nota||v.notas||"").length>250?"...":""}</p>`:""}
  </div>`;
}

function renderResumenAg(label, d) {
  const partes = [];
  if (d.vis > 0) partes.push(`<span style="background:#DCFCE7;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;color:#166534">👋 ${d.vis} visita${d.vis>1?"s":""}</span>`);
  if (d.ops > 0) partes.push(`<span style="background:#DBEAFE;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;color:#1E3A5F">💼 ${d.ops} ops</span>`);
  if (d.est > 0) partes.push(`<span style="background:#F3E8FF;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;color:#7C3AED">🎯 ${d.est} estr</span>`);
  if (d.mue > 0) partes.push(`<span style="background:#FEF3C7;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;color:#92400E">📦 ${d.mue} muestras</span>`);
  if (partes.length === 0) partes.push(`<span style="color:#94A3B8;font-size:11px;font-style:italic">Sin actividad</span>`);
  return `<div style="background:#F8FAFC;border-radius:10px;padding:10px 14px;margin-bottom:6px;border:1px solid #E2E8F0">
    <p style="margin:0 0 6px;font-weight:700;font-size:13px;color:#1E3A5F">${label}</p>
    <div style="display:flex;gap:6px;flex-wrap:wrap">${partes.join("")}</div>
  </div>`;
}

// ══════════════════════════════════════════════════════════
// BUILD EMAIL
// ══════════════════════════════════════════════════════════
function buildEmail(ctx) {
  const { titulo, nombre, fecha, totales, porEquipo, porVendedor, datos, nombreMap, semana } = ctx;
  const fechaTxt = fmtFecha(fecha);

  let html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#F0F4F8;padding:16px;color:#0F172A">
  <div style="max-width:680px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#1E3A5F,#3B82F6);color:#fff;padding:24px 20px">
      <p style="margin:0;font-size:13px;opacity:.8">📅 Actividad del ${fechaTxt} · Semana ${semana}</p>
      <h1 style="margin:6px 0 0;font-size:22px">${titulo}</h1>
    </div>
    <div style="padding:20px">
    <p style="margin:0 0 16px;font-size:15px">Hola <b>${nombre}</b>, este es el resumen de actividad comercial del <b>${fechaTxt.toLowerCase()}</b>:</p>`;

  // 1. ACTIVIDAD DEL DÍA
  html += `<p style="${S.hdr}">📊 Actividad del día</p>
    <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:16px">
      ${kpiSimple(totales.visitas,"Visitas","#22C55E")}
      ${kpiSimple(totales.clientesNuevos,"Cl. nuevos","#0EA5E9")}
      ${kpiSimple(totales.muestrasNuevas,"Muestras","#F59E0B")}
      ${kpiSimple(totales.estrategias,"Estrategias","#7C3AED")}
      ${kpiSimple(totales.oportunidades,"Oportunidades","#1E3A5F")}
    </div>`;

  // 2. POR EQUIPO
  if (porEquipo && porEquipo.length > 0) {
    html += `<p style="${S.hdr}">🏢 Por equipo</p>`;
    porEquipo.forEach(eq => { html += renderResumenAg("📦 " + eq.equipo, eq); });
  }

  // 3. POR VENDEDOR
  if (porVendedor && porVendedor.length > 0) {
    html += `<p style="${S.hdr}">👥 Por vendedor</p>`;
    let curEq = "";
    porVendedor.forEach(v => {
      if (v.equipo !== curEq) { curEq = v.equipo; html += `<div style="background:#1E3A5F;color:#fff;padding:6px 12px;border-radius:6px;margin:10px 0 6px;font-size:13px;font-weight:700">${curEq}</div>`; }
      html += renderResumenAg("👤 " + v.nombre, v);
    });
  }

  // 4. VISITAS DETALLADAS
  html += `<p style="${S.hdr}">📋 Visitas del día</p>`;
  const visList = datos.visitas;
  if (visList.length === 0) html += `<p style="font-size:12px;color:#94A3B8;margin:8px 0">Sin visitas registradas este día</p>`;
  else visList.forEach(v => { html += renderVis(v, true, nombreMap); });

  // 5. MUESTRAS
  html += `<p style="${S.hdr}">📦 Muestras</p>`;
  const { mNuevas, mResueltas } = datos;
  if (mNuevas.length === 0 && mResueltas.length === 0) html += `<p style="font-size:12px;color:#94A3B8;margin:8px 0">Sin actividad de muestras</p>`;
  else {
    if (mNuevas.length > 0) {
      html += `<p style="margin:8px 0 4px;font-size:13px;font-weight:700;color:#F59E0B">🆕 Nuevas (${mNuevas.length})</p>`;
      mNuevas.forEach(m => {
        html += `<div style="border-left:3px solid #F59E0B;padding:4px 0 4px 10px;margin-bottom:4px"><p style="margin:0;font-size:12px"><b>${m.cliente||"—"}</b> — ${m.prod||m.tipo||"?"} <span style="color:#64748B">(${nombreMap[String(m.agente||"").toUpperCase()]||m.agente||""})</span></p></div>`;
      });
    }
    if (mResueltas.length > 0) {
      html += `<p style="margin:12px 0 4px;font-size:13px;font-weight:700;color:#22C55E">✅ Resueltas (${mResueltas.length})</p>`;
      mResueltas.forEach(m => {
        const ic = m.estado==="pedido"||m.estado==="positivo"?"✅":"❌";
        // (v3.23.7) Extraer nota/feedback
        let notaFb = m.nota || m.feedback || m.comentarioFeedback || m.notaFeedback || "";
        if (!notaFb && m.motivo) notaFb = "Motivo: " + m.motivo;
        const notaHtml = notaFb ? `<p style="margin:2px 0 0 18px;font-size:11px;color:#475569;font-style:italic">💬 ${notaFb.substring(0,180)}${notaFb.length>180?"…":""}</p>` : "";
        html += `<div style="padding:4px 0 6px 10px;margin-bottom:4px;border-left:3px solid ${m.estado==="pedido"||m.estado==="positivo"?"#22C55E":"#EF4444"}"><p style="margin:0;font-size:12px">${ic} <b>${m.cliente||"—"}</b> — ${m.prod||m.tipo||"?"} → ${m.estado||"?"} <span style="color:#64748B">(${nombreMap[String(m.agente||"").toUpperCase()]||m.agente||""})</span></p>${notaHtml}</div>`;
      });
    }
  }

  // 6. HITOS DEL DÍA
  html += `<p style="${S.hdr}">🏗️ Hitos de proyectos</p>`;
  const { hitosOk, hitosPend } = datos;
  if (hitosOk.length === 0 && hitosPend.length === 0) html += `<p style="font-size:12px;color:#94A3B8;margin:8px 0">Sin hitos en esta fecha</p>`;
  else {
    if (hitosOk.length > 0) {
      html += `<p style="margin:8px 0 4px;font-size:13px;font-weight:700;color:#22C55E">✅ Completados (${hitosOk.length})</p>`;
      hitosOk.forEach(h => {
        html += `<div style="padding:4px 0 4px 10px;margin-bottom:4px;border-left:3px solid #22C55E"><p style="margin:0;font-size:12px"><b>${h.nombre}</b> <span style="color:#64748B">· ${h.proyecto} (${nombreMap[String(h.responsable||"").toUpperCase()]||h.responsable||""})</span></p></div>`;
      });
    }
    if (hitosPend.length > 0) {
      html += `<p style="margin:12px 0 4px;font-size:13px;font-weight:700;color:#EF4444">⏳ Vencen / vencieron este día (${hitosPend.length})</p>`;
      hitosPend.forEach(h => {
        html += `<div style="padding:4px 0 4px 10px;margin-bottom:4px;border-left:3px solid ${h.vencido?"#EF4444":"#F59E0B"}"><p style="margin:0;font-size:12px">${h.vencido?"🔴":"🟡"} <b>${h.nombre}</b> <span style="color:#64748B">· ${h.proyecto} · ${h.fecha||"sin fecha"} (${nombreMap[String(h.responsable||"").toUpperCase()]||h.responsable||""})</span></p></div>`;
      });
    }
  }

  // 7. ESTRATEGIAS
  html += `<p style="${S.hdr}">🎯 Estrategias</p>`;
  const { estNew, estDone } = datos;
  if (estNew.length === 0 && estDone.length === 0) html += `<p style="font-size:12px;color:#94A3B8;margin:8px 0">Sin estrategias este día</p>`;
  else {
    if (estNew.length > 0) {
      html += `<p style="margin:8px 0 4px;font-size:13px;font-weight:700;color:#7C3AED">🆕 Nuevas / Activas (${estNew.length})</p>`;
      estNew.forEach(e => {
        html += `<div style="border-left:3px solid #7C3AED;padding:4px 0 4px 10px;margin-bottom:4px"><p style="margin:0;font-size:12px"><b>${e.clienteNombre||e.cliente||"—"}</b> — ${e.tipo||"?"}: ${e.objetivo||e.texto||""} <span style="color:#64748B">(${e.agenteNombre||nombreMap[String(e.creadoPor||e.agente||"").toUpperCase()]||e.creadoPor||""})</span></p></div>`;
      });
    }
    if (estDone.length > 0) {
      html += `<p style="margin:12px 0 4px;font-size:13px;font-weight:700;color:#22C55E">✅ Resueltas (${estDone.length})</p>`;
      estDone.forEach(e => {
        html += `<div style="padding:2px 0 2px 10px;margin-bottom:2px"><p style="margin:0;font-size:12px">✅ <b>${e.clienteNombre||e.cliente||"—"}</b> — ${e.resultado||e.estado||"?"} <span style="color:#64748B">(${e.agenteNombre||nombreMap[String(e.creadoPor||e.agente||"").toUpperCase()]||e.creadoPor||""})</span></p></div>`;
      });
    }
  }

  // 8. OPORTUNIDADES
  html += `<p style="${S.hdr}">💼 Oportunidades</p>`;
  const { opsDone, opsNew, opsManaged } = datos;
  const _allOpsEmpty = opsDone.length === 0 && opsNew.length === 0 && (!opsManaged || opsManaged.length === 0);
  if (_allOpsEmpty) html += `<p style="font-size:12px;color:#94A3B8;margin:8px 0">Sin oportunidades</p>`;
  else {
    if (opsDone.length > 0) {
      html += `<p style="margin:8px 0 4px;font-size:13px;font-weight:700;color:#22C55E">✅ Resueltas (${opsDone.length})</p>`;
      opsDone.forEach(o => {
        const ic = o.estado==="ganada"?"🏆":o.estado==="perdida"?"❌":"✅";
        // (v3.23.7) Extraer nota/motivo de cierre
        let notaCierre = "";
        if (Array.isArray(o.actividad)) {
          // Buscar la última entrada de tipo "etapa" o "nota" (la más reciente)
          for (let i = o.actividad.length - 1; i >= 0; i--) {
            const a = o.actividad[i];
            if (a && (a.tipo === "etapa" || a.tipo === "nota") && a.texto) {
              notaCierre = a.texto;
              break;
            }
          }
        }
        if (!notaCierre && o.motivoPerdida) notaCierre = "Motivo: " + o.motivoPerdida;
        if (!notaCierre && o.notaCierre) notaCierre = o.notaCierre;
        if (!notaCierre && typeof o.notas === "string") notaCierre = o.notas;
        const notaHtml = notaCierre ? `<p style="margin:2px 0 0 18px;font-size:11px;color:#475569;font-style:italic">💬 ${notaCierre.substring(0,180)}${notaCierre.length>180?"…":""}</p>` : "";
        html += `<div style="padding:4px 0 6px 10px;margin-bottom:4px;border-left:3px solid ${o.estado==="ganada"?"#22C55E":o.estado==="perdida"?"#EF4444":"#1E3A5F"}"><p style="margin:0;font-size:12px">${ic} <b>${o.cliente||o.nombre||"—"}</b> — ${fN(o.valor||0)}€ (${o.estado||"?"}) <span style="color:#64748B">(${nombreMap[String(o.agente||o.agenteId||"").toUpperCase()]||o.agente||""})</span></p>${notaHtml}</div>`;
      });
    }
    if (opsNew.length > 0) {
      html += `<p style="margin:12px 0 4px;font-size:13px;font-weight:700;color:#1E3A5F">🆕 Nuevas (${opsNew.length})</p>`;
      opsNew.forEach(o => {
        html += `<div style="padding:2px 0 2px 10px;margin-bottom:2px;border-left:3px solid #1E3A5F"><p style="margin:0;font-size:12px"><b>${o.cliente||o.nombre||"—"}</b> — ${fN(o.valor||0)}€ (${o.estado||o.etapa||"pendiente"}) <span style="color:#64748B">(${nombreMap[String(o.agente||o.agenteId||"").toUpperCase()]||o.agente||""})</span></p></div>`;
      });
    }
    // (v3.23.7) Oportunidades GESTIONADAS hoy (con actividad nueva pero no cerradas ni nuevas)
    if (opsManaged && opsManaged.length > 0) {
      html += `<p style="margin:12px 0 4px;font-size:13px;font-weight:700;color:#F59E0B">⚡ Gestionadas hoy (${opsManaged.length})</p>`;
      opsManaged.forEach(o => {
        // Buscar la última actividad de hoy
        let textoUlt = "";
        if (Array.isArray(o.actividad)) {
          for (let i = o.actividad.length - 1; i >= 0; i--) {
            const a = o.actividad[i];
            if (a && a.texto) { textoUlt = a.texto; break; }
          }
        }
        const notaHtml = textoUlt ? `<p style="margin:2px 0 0 18px;font-size:11px;color:#475569;font-style:italic">💬 ${textoUlt.substring(0,180)}${textoUlt.length>180?"…":""}</p>` : "";
        html += `<div style="padding:4px 0 6px 10px;margin-bottom:4px;border-left:3px solid #F59E0B"><p style="margin:0;font-size:12px">⚡ <b>${o.cliente||o.nombre||"—"}</b> — ${fN(o.valor||0)}€ (${o.estado||o.etapa||"en curso"}) <span style="color:#64748B">(${nombreMap[String(o.agente||o.agenteId||"").toUpperCase()]||o.agente||""})</span></p>${notaHtml}</div>`;
      });
    }
  }

  // (v3.23.9) 9. OFERTAS / COTIZACIONES
  html += `<p style="${S.hdr}">💰 Ofertas / Cotizaciones</p>`;
  const { ofNew, ofDone } = datos;
  if ((!ofNew || ofNew.length === 0) && (!ofDone || ofDone.length === 0)) {
    html += `<p style="font-size:12px;color:#94A3B8;margin:8px 0">Sin actividad de ofertas</p>`;
  } else {
    if (ofDone && ofDone.length > 0) {
      html += `<p style="margin:8px 0 4px;font-size:13px;font-weight:700;color:#22C55E">✅ Resueltas (${ofDone.length})</p>`;
      ofDone.forEach(of => {
        const ic = of.estado === "pedido" ? "✅" : of.estado === "caro" ? "💸" : of.estado === "no_responde" ? "🔇" : "•";
        const lblEstado = of.estado === "pedido" ? "Pedido" : of.estado === "caro" ? "Vamos caros" : of.estado === "no_responde" ? "No responde" : of.estado;
        const colorEstado = of.estado === "pedido" ? "#22C55E" : of.estado === "caro" ? "#DC2626" : of.estado === "no_responde" ? "#94A3B8" : "#1E3A5F";
        const lineas = (of.lineas || []).map(l => {
          const precio = Number(l.precio || 0).toFixed(2).replace(".", ",");
          const compStr = l.precioCompetencia != null ? ` <span style="color:#DC2626">(comp: ${Number(l.precioCompetencia).toFixed(2).replace(".", ",")})</span>` : "";
          return `${l.producto || ""}${l.calibre ? " · " + l.calibre : ""}: ${precio} ${l.unidad || "€/kg"}${compStr}`;
        }).join(" · ");
        const lineasHtml = lineas ? `<p style="margin:2px 0 0 18px;font-size:11px;color:#475569">📦 ${lineas.substring(0, 250)}${lineas.length > 250 ? "…" : ""}</p>` : "";
        html += `<div style="padding:4px 0 6px 10px;margin-bottom:4px;border-left:3px solid ${colorEstado}"><p style="margin:0;font-size:12px">${ic} <b>${of.clienteNombre || "—"}</b> — ${lblEstado} <span style="color:#64748B">(${nombreMap[String(of.agente || "").toUpperCase()] || of.agenteNombre || of.agente || ""})</span></p>${lineasHtml}</div>`;
      });
    }
    if (ofNew && ofNew.length > 0) {
      html += `<p style="margin:12px 0 4px;font-size:13px;font-weight:700;color:#F59E0B">🆕 Nuevas (${ofNew.length})</p>`;
      ofNew.forEach(of => {
        const lineas = (of.lineas || []).map(l => {
          const precio = Number(l.precio || 0).toFixed(2).replace(".", ",");
          return `${l.producto || ""}${l.calibre ? " · " + l.calibre : ""}: ${precio} ${l.unidad || "€/kg"}`;
        }).join(" · ");
        const lineasHtml = lineas ? `<p style="margin:2px 0 0 18px;font-size:11px;color:#475569">📦 ${lineas.substring(0, 250)}${lineas.length > 250 ? "…" : ""}</p>` : "";
        html += `<div style="padding:4px 0 6px 10px;margin-bottom:4px;border-left:3px solid #F59E0B"><p style="margin:0;font-size:12px">⏳ <b>${of.clienteNombre || "—"}</b> — ${(of.lineas || []).length} línea${(of.lineas || []).length === 1 ? "" : "s"} <span style="color:#64748B">(${nombreMap[String(of.agente || "").toUpperCase()] || of.agenteNombre || of.agente || ""})</span></p>${lineasHtml}</div>`;
      });
    }
  }

  html += `<p style="margin:24px 0 0;text-align:center"><a href="https://crmwikuk.vercel.app" style="display:inline-block;background:#1E3A5F;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">Abrir CRM</a></p>
    <p style="margin:20px 0 0;font-size:10px;color:#94A3B8;text-align:center">Grupo Consolidado · Daily ${fechaTxt}</p>
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
    const fecha = fechaDesdeQuery(req);
    const semana = getSemanaISO(fecha);

    const [usuarios, portalUsers, visitas, oportunidades, estrategias, muestras, proyectos, clientes, ofertas] = await Promise.all([
      fbList("usuarios"), fbList("portal_users"), fbList("visitas"), fbList("oportunidades"),
      fbList("estrategias"), fbList("muestras"),
      fbList("proyectos"), fbList("clientes"),
      fbList("ofertas"),
    ]);

    // (v3.23.8) Mezclar portal_users con usuarios para captar Esther, JLGarcia y demás del portal
    // que pueden tener visitas registradas pero no estar en colección "usuarios"
    const usuariosIdsExistentes = new Set();
    usuarios.forEach(u => {
      if (u.id) usuariosIdsExistentes.add(String(u.id).toUpperCase());
      if (u.grupoAgente) usuariosIdsExistentes.add(String(u.grupoAgente).toUpperCase());
      if (u.username) usuariosIdsExistentes.add(String(u.username).toUpperCase());
      if (u.catalogoVendedor) usuariosIdsExistentes.add(String(u.catalogoVendedor).toUpperCase());
    });
    (portalUsers || []).forEach(pu => {
      if (pu.eliminada) return;
      // Saltar si ya existe un usuario CRM equivalente
      const cv = (pu.catalogoVendedor || "").toUpperCase();
      const un = (pu.username || "").toUpperCase();
      const nm = (pu.nombre || "").toUpperCase();
      if (cv && usuariosIdsExistentes.has(cv)) return;
      if (un && usuariosIdsExistentes.has(un)) return;
      if (pu.id && usuariosIdsExistentes.has(String(pu.id).toUpperCase())) return;
      // Es un empleado solo del portal — añadirlo como agente
      usuarios.push({
        id: pu.id || pu.username || pu.nombre,
        nombre: pu.nombre || pu.username || pu.id,
        rol: pu.rol || "agente", // por defecto considerar agente para que aparezca en el daily
        equipo: pu.equipo || "",
        email: pu.email || "",
        grupoAgente: pu.catalogoVendedor || pu.username || "",
        username: pu.username || "",
        _fromPortal: true,
      });
    });

    // Map ID → nombre
    const nombreMap = {};
    usuarios.forEach(u => {
      if (u.nombre) {
        nombreMap[String(u.id||"").toUpperCase()] = u.nombre;
        if (u.grupoAgente) nombreMap[String(u.grupoAgente).toUpperCase()] = u.nombre;
        if (u.username) nombreMap[String(u.username).toUpperCase()] = u.nombre;
        if (u.catalogoVendedor) nombreMap[String(u.catalogoVendedor).toUpperCase()] = u.nombre;
        nombreMap[String(u.nombre).toUpperCase()] = u.nombre;
      }
    });

    const noElim = arr => arr.filter(x => !x.eliminada);
    const visDia = noElim(visitas).filter(x => enFecha(x, fecha));
    const estDia = noElim(estrategias).filter(x => enFecha(x, fecha));
    // Muestras del día — incluir las nuevas (creadas hoy) Y las que tuvieron feedback hoy (resueltas hoy aunque sean antiguas)
    const mueDiaCreadas = noElim(muestras).filter(x => enFecha(x, fecha));
    const mueDiaResueltas = noElim(muestras).filter(m => {
      if (!m.fechaFeedback) return false;
      const f = parseFecha(m.fechaFeedback);
      return f && mismaFecha(f, fecha);
    });
    // Combinar sin duplicar
    const mueDiaIds = new Set();
    const mueDia = [];
    [...mueDiaCreadas, ...mueDiaResueltas].forEach(m => {
      const id = m.id || m._id || JSON.stringify(m);
      if (!mueDiaIds.has(id)) { mueDiaIds.add(id); mueDia.push(m); }
    });
    const cliNuevos = noElim(clientes).filter(c => c.esNuevo && enFecha(c, fecha));

    // Oportunidades: nuevas + resueltas EN ESTE DÍA (basado en fechaCreacion / fecha de cierre)
    const opsDia = noElim(oportunidades).filter(x => enFecha(x, fecha));
    const opsNuevasDia = opsDia.filter(o => !["ganada","perdida","cerrada"].includes(o.estado));
    const opsResueltasDia = noElim(oportunidades).filter(o => {
      if (!["ganada","perdida","cerrada"].includes(o.estado)) return false;
      // intentar fecha de cierre
      const f = parseFecha(o.fechaCierre || o.fechaResolucion || o.fechaActualizacion || o.fechaCreacion);
      return f && mismaFecha(f, fecha);
    });
    // (v3.23.7) Oportunidades con ACTIVIDAD hoy (notas, cambios de etapa) aunque sean antiguas y no cerradas
    const opsGestionadasDia = noElim(oportunidades).filter(o => {
      // Excluir si ya está en nuevas o resueltas
      if (opsNuevasDia.includes(o) || opsResueltasDia.includes(o)) return false;
      // No incluir cerradas (esas van en opsResueltasDia)
      if (["ganada","perdida","cerrada"].includes(o.estado)) return false;
      // Buscar si tuvo actividad hoy
      if (Array.isArray(o.actividad)) {
        for (const a of o.actividad) {
          if (a && a.fecha) {
            const f = parseFecha(a.fecha);
            if (f && mismaFecha(f, fecha)) return true;
          }
        }
      }
      // fechaUltimoCambio o fechaActualizacion
      if (o.fechaUltimoCambio) {
        const f = parseFecha(o.fechaUltimoCambio);
        if (f && mismaFecha(f, fecha)) return true;
      }
      if (o.fechaActualizacion) {
        const f = parseFecha(o.fechaActualizacion);
        if (f && mismaFecha(f, fecha)) return true;
      }
      return false;
    });

    // (v3.23.9) OFERTAS del día — nuevas (creadas hoy, pendientes) y resueltas (cierre hoy: pedido/caro/no_responde)
    const ofNuevasDia = noElim(ofertas).filter(o => {
      if (o.estado && o.estado !== "pendiente") return false;
      const f = parseFecha(o.fechaCreacion || o.fechaCreacionStr);
      return f && mismaFecha(f, fecha);
    });
    const ofResueltasDia = noElim(ofertas).filter(o => {
      if (!o.estado || o.estado === "pendiente") return false;
      // Buscar fecha de cierre/cambio
      const f = parseFecha(o.fechaCierre || o.fechaUltimoCambio);
      return f && mismaFecha(f, fecha);
    });

    // Hitos del día
    const hitosOk = [], hitosPend = [];
    const fechaStr = fecha.toISOString().split("T")[0];
    const hoyStr = new Date().toISOString().split("T")[0];
    noElim(proyectos).filter(p => p.estado === "activo").forEach(p => {
      (p.hitos||[]).forEach(h => {
        if (typeof h !== "object" || !h) return;
        const f = h.fecha||"", fISO = f.includes("/") ? f.split("/").reverse().join("-") : f;
        if (h.hecho) {
          const fH = h.fechaHecho||h.fecha||"", fHISO = fH.includes("/") ? fH.split("/").reverse().join("-") : fH;
          if (fHISO === fechaStr) hitosOk.push({ nombre:h.nombre||"Sin nombre", proyecto:p.nombre||"", responsable:h.responsable||"", fechaHecho:fH });
        } else {
          // pendiente con fecha = este día (vence hoy o vencido por antes)
          if (fISO === fechaStr) hitosPend.push({ nombre:h.nombre||"Sin nombre", proyecto:p.nombre||"", responsable:h.responsable||"", fecha:f, vencido:fISO < hoyStr });
        }
      });
    });

    // Muestras split
    const mNuevas = mueDia.filter(m => !m.fechaFeedback || m.estadoMuestra==="PENDIENTE DE ENVIAR" || m.estadoMuestra==="ENVIADO");
    const mResueltas = mueDia.filter(m => m.fechaFeedback && (m.estado==="pedido"||m.estado==="positivo"||m.estado==="ko"));

    // Estrategias split
    const estNew = estDia.filter(e => !e.resultado || e.resultado === "");
    const estDone = estDia.filter(e => e.resultado && e.resultado !== "");

    // SMTP
    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT||"587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    const sent = [], errors = [];

    function idsAg(ag) {
      const ids = new Set();
      // (v3.23.8) Más permisivo - incluir todos los identificadores posibles
      ["id","grupoAgente","nombre","username","catalogoVendedor"].forEach(k => { if (ag[k]) ids.add(String(ag[k]).toUpperCase()); });
      return ids;
    }

    // ── Filtro de aprobación jerárquica ──
    // Mismo principio que weekly-summary: usar !== false para que lo no marcado se INCLUYA
    function aplicarAprobacion(arr, level) {
      if (level === "dir") return arr.filter(x => x.aprobadoResp !== false);
      if (level === "ceo") return arr.filter(x => x.aprobadoResp !== false && x.aprobadoJefe !== false);
      return arr; // agente / resp → sin filtro
    }

    // ── Build context for a scope of agents ──
    function buildCtx(titulo, mgNombre, agentesScope, esJefe, aprobacionLevel) {
      const visFiltradas = aplicarAprobacion(visDia, aprobacionLevel);
      const opsNuevasFiltradas = aplicarAprobacion(opsNuevasDia, aprobacionLevel);
      const opsResueltasFiltradas = aplicarAprobacion(opsResueltasDia, aprobacionLevel);
      const opsGestionadasFiltradas = aplicarAprobacion(opsGestionadasDia, aprobacionLevel);
      // (v3.23.9) Ofertas
      const ofNuevasFiltradas = aplicarAprobacion(ofNuevasDia, aprobacionLevel);
      const ofResueltasFiltradas = aplicarAprobacion(ofResueltasDia, aprobacionLevel);

      const allIds = new Set();
      agentesScope.forEach(u => idsAg(u).forEach(id => allIds.add(id)));
      const sf = arr => arr.filter(x => pertA(x, allIds));

      const porVendedor = agentesScope.map(ag => {
        const ids = idsAg(ag);
        return {
          nombre: ag.nombre || ag.id,
          equipo: ag.equipo || "SIN EQUIPO",
          vis: sf(visFiltradas).filter(x => pertA(x, ids)).length,
          ops: sf(opsNuevasFiltradas).filter(x => pertA(x, ids)).length + sf(opsResueltasFiltradas).filter(x => pertA(x, ids)).length + sf(opsGestionadasFiltradas).filter(x => pertA(x, ids)).length,
          est: sf(estDia).filter(x => pertA(x, ids)).length,
          mue: sf(mueDia).filter(x => pertA(x, ids)).length,
        };
      }).sort((a, b) => b.vis - a.vis || b.ops - a.ops);

      let porEquipo = null;
      if (!esJefe) {
        porEquipo = ["WIKUK","INTERKEY"].map(eq => {
          const idsEq = new Set();
          usuarios.filter(u => u.equipo === eq).forEach(u => idsAg(u).forEach(id => idsEq.add(id)));
          return {
            equipo: eq,
            vis: sf(visFiltradas).filter(x => pertA(x, idsEq)).length,
            ops: sf(opsNuevasFiltradas).filter(x => pertA(x, idsEq)).length + sf(opsResueltasFiltradas).filter(x => pertA(x, idsEq)).length,
            est: sf(estDia).filter(x => pertA(x, idsEq)).length,
            mue: sf(mueDia).filter(x => pertA(x, idsEq)).length,
          };
        });
      }

      return {
        titulo, nombre: mgNombre, fecha, semana, nombreMap,
        totales: {
          visitas: sf(visFiltradas).length,
          clientesNuevos: cliNuevos.filter(c => pertA(c, allIds) || !esJefe).length,
          muestrasNuevas: mNuevas.filter(m => pertA(m, allIds) || !esJefe).length,
          estrategias: sf(estDia).length,
          oportunidades: sf(opsNuevasFiltradas).length + sf(opsResueltasFiltradas).length,
        },
        porEquipo, porVendedor,
        datos: {
          visitas: sf(visFiltradas),
          mNuevas: mNuevas.filter(m => pertA(m, allIds) || !esJefe),
          mResueltas: mResueltas.filter(m => pertA(m, allIds) || !esJefe),
          hitosOk: hitosOk.filter(h => allIds.has(String(h.responsable||"").toUpperCase()) || !esJefe),
          hitosPend: hitosPend.filter(h => allIds.has(String(h.responsable||"").toUpperCase()) || !esJefe),
          estNew: estNew.filter(e => pertA(e, allIds) || !esJefe),
          estDone: estDone.filter(e => pertA(e, allIds) || !esJefe),
          opsDone: opsResueltasFiltradas.filter(o => pertA(o, allIds) || !esJefe),
          opsNew: opsNuevasFiltradas.filter(o => pertA(o, allIds) || !esJefe),
          opsManaged: opsGestionadasFiltradas.filter(o => pertA(o, allIds) || !esJefe),
          ofNew: ofNuevasFiltradas.filter(o => pertA(o, allIds) || !esJefe),
          ofDone: ofResueltasFiltradas.filter(o => pertA(o, allIds) || !esJefe),
        },
      };
    }

    const fechaTxt = fmtFecha(fecha);

    // ── MANAGERS ──
    const managers = usuarios.filter(u => ["jefe","director","ceo"].includes(u.rol) && u.email);
    for (const mg of managers) {
      const esJefe = mg.rol === "jefe";
      // (v3.23.8) Roles activos ampliado para incluir empleados del portal sin rol específico
      const rolesActivos = ["agente","crm_agente","jefe","director","ceo","empleado"];
      const scope = usuarios.filter(u => {
        // Incluir todos los roles activos + cualquier usuario del portal con actividad
        const rolOk = rolesActivos.includes(u.rol) || u._fromPortal;
        if (!rolOk) return false;
        if (esJefe) return u.equipo === mg.equipo || u.id === mg.id;
        return true;
      });
      const aprobLvl = mg.rol === "director" ? "dir" : mg.rol === "ceo" ? "ceo" : "resp";
      const ctx = buildCtx(
        esJefe ? `Daily · Equipo ${mg.equipo}` : `Daily comercial · ${fechaTxt}`,
        mg.nombre, scope, esJefe, aprobLvl
      );
      const html = buildEmail(ctx);
      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: mg.email,
          subject: `📅 Daily ${fechaTxt}${esJefe ? " · " + mg.equipo : ""}`,
          html,
        });
        sent.push({ tipo: mg.rol, nombre: mg.nombre, email: mg.email });
      } catch (err) {
        errors.push({ tipo: mg.rol, email: mg.email, error: err.message });
      }
    }

    // ── AGENTES ──
    const agentes = usuarios.filter(u => (u.rol === "agente" || u.rol === "crm_agente") && u.email);
    for (const ag of agentes) {
      const ctx = buildCtx(`Tu daily · ${fechaTxt}`, ag.nombre, [ag], true, "agente");
      ctx.porVendedor = []; ctx.porEquipo = null;
      const html = buildEmail(ctx);
      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: ag.email,
          subject: `📅 Tu daily ${fechaTxt} · ${ag.nombre || ag.id}`,
          html,
        });
        sent.push({ tipo: "agente", nombre: ag.nombre, email: ag.email });
      } catch (err) {
        errors.push({ tipo: "agente", email: ag.email, error: err.message });
      }
    }

    return res.status(200).json({
      ok: true,
      fecha: fecha.toISOString().split("T")[0],
      diaSemana: fechaTxt,
      semana,
      totales: {
        visitas: visDia.length,
        ops: opsDia.length,
        opsResueltas: opsResueltasDia.length,
        est: estDia.length,
        mue: mueDia.length,
        cliNuevos: cliNuevos.length,
      },
      sent,
      errors,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, stack: err.stack });
  }
}
