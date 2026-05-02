// /api/weekly-summary.js  —  v4
// Cron: viernes 17:00 UTC (19:00 CEST)
// Informe semanal completo con objetivos, desglose por día, hitos, etc.

const FB = "https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents";

// ── Firebase helpers ──
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

// ── Date helpers ──
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
  for (const k of ["fecha","fechaCreacion","creadoEn","fechaAlta","creadaEn"]) { const d = parseFecha(item[k]); if (d && d >= lu && d <= vi) return true; }
  return false;
}
function perteneceA(item, ids) {
  return ids.has(String(item.agente||item.agenteId||item.autor||item.creadoPor||item.responsable||"").toUpperCase());
}
const DIAS = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
function diaKey(fecha) {
  const d = parseFecha(fecha); if (!d) return "Sin fecha";
  return `${DIAS[d.getDay()]} ${d.getDate()}/${d.getMonth()+1}`;
}
function colorR(r) { return {visitado:"#22C55E",nuevo_pedido:"#16A34A",seguimiento:"#3B82F6",llamada:"#8B5CF6",no_disponible:"#F59E0B",no_compra:"#EF4444",sin_contacto:"#94A3B8"}[r]||"#64748B"; }
function labelR(r) { return {visitado:"Visitado",nuevo_pedido:"Nuevo pedido",seguimiento:"Seguimiento",llamada:"Llamada",no_disponible:"No disponible",no_compra:"No compra",sin_contacto:"Sin contacto"}[r]||(r||"—"); }

// ── HTML helpers ──
const S = { box: "border-radius:10px;padding:12px 14px;margin-bottom:8px;", hdr: "margin:24px 0 10px;font-size:15px;font-weight:800;color:#1E3A5F;border-bottom:2px solid #E2E8F0;padding-bottom:6px;" };

function kpiVsObj(val, obj, label, color, unit) {
  const pct = obj > 0 ? Math.round(val / obj * 100) : null;
  const pctColor = pct === null ? "#94A3B8" : pct >= 100 ? "#22C55E" : pct >= 70 ? "#F59E0B" : "#EF4444";
  return `<div style="flex:1;min-width:120px;background:${color}10;border:1px solid ${color}30;border-radius:10px;padding:12px;text-align:center">
    <p style="margin:0;font-size:20px;font-weight:800;color:${color}">${fN(val)}${unit}</p>
    ${obj > 0 ? `<p style="margin:2px 0 0;font-size:11px;color:#64748B">obj: ${fN(obj)}${unit}</p>
    <p style="margin:2px 0 0;font-size:13px;font-weight:700;color:${pctColor}">${pct}%</p>` : `<p style="margin:2px 0 0;font-size:11px;color:#94A3B8">${label}</p>`}
  </div>`;
}

function kpiSimple(val, label, color) {
  return `<div style="flex:1;min-width:70px;background:${color}15;border-radius:10px;padding:10px;text-align:center"><p style="margin:0;font-size:20px;font-weight:800;color:${color}">${val}</p><p style="margin:0;font-size:10px;color:#64748B">${label}</p></div>`;
}

function groupByDay(items, fechaField) {
  const groups = {};
  const order = ["Lunes","Martes","Miércoles","Jueves","Viernes"];
  items.forEach(item => {
    const dk = diaKey(item[fechaField] || item.fecha || item.fechaCreacion || item.creadoEn || item.creadaEn || item.fechaAlta);
    if (!groups[dk]) groups[dk] = [];
    groups[dk].push(item);
  });
  // Sort by day order
  const sorted = {};
  const keys = Object.keys(groups).sort((a, b) => {
    const da = order.findIndex(d => a.startsWith(d));
    const db = order.findIndex(d => b.startsWith(d));
    return (da === -1 ? 99 : da) - (db === -1 ? 99 : db);
  });
  keys.forEach(k => sorted[k] = groups[k]);
  return sorted;
}

function renderDayHeader(dia) {
  return `<div style="background:#1E3A5F;color:#fff;padding:6px 12px;border-radius:6px;margin:12px 0 6px;font-size:12px;font-weight:700">📅 ${dia}</div>`;
}

function renderVisitaDetalle(v, showAgent) {
  return `<div style="border-left:3px solid ${colorR(v.resultado)};padding:6px 0 6px 10px;margin-bottom:6px;background:#FAFAFA;border-radius:0 6px 6px 0">
    <p style="margin:0;font-size:13px;font-weight:600;color:#0F172A">${v.clienteNombre||v.cliente||"—"}${showAgent ? ` <span style="color:#64748B;font-weight:400;font-size:11px">(${v.creadoPorNombre||v.agente||""})</span>` : ""}</p>
    <p style="margin:2px 0 0;font-size:11px;color:#64748B"><span style="color:${colorR(v.resultado)};font-weight:600">${labelR(v.resultado)}</span>${v.ciudad?" · "+v.ciudad:""}${v.contacto?" · "+v.contacto:""}</p>
    ${v.nota||v.notas?`<p style="margin:3px 0 0;font-size:11px;color:#475569;line-height:1.4">${(v.nota||v.notas).substring(0,250)}${(v.nota||v.notas||"").length>250?"...":""}</p>`:""}
  </div>`;
}

// ══════════════════════════════════════════════════════════
// BUILD EMAIL — DIRECTOR/JEFE/CEO
// ══════════════════════════════════════════════════════════
function buildEmailDirector(ctx) {
  const { titulo, nombre, semana, lu, vi, totales, porVendedor, porDia } = ctx;
  const fD = d => d.toLocaleDateString("es-ES", { day:"2-digit", month:"short" });

  // ── 1. RESUMEN EJECUTIVO ──
  let html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#F0F4F8;padding:16px;color:#0F172A">
  <div style="max-width:680px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#1E3A5F,#3B82F6);color:#fff;padding:24px 20px">
      <p style="margin:0;font-size:13px;opacity:.8">📅 Semana ${semana} · ${fD(lu)} → ${fD(vi)}</p>
      <h1 style="margin:6px 0 0;font-size:22px">${titulo}</h1>
    </div>
    <div style="padding:20px">
    <p style="margin:0 0 16px;font-size:15px">Hola <b>${nombre}</b>, aquí tienes el informe completo:</p>`;

  // Ventas vs objetivo
  html += `<p style="${S.hdr}">💰 Resultados económicos</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      ${kpiVsObj(totales.ventas, totales.oVentas, "Ventas", "#166534", "€")}
      ${kpiVsObj(totales.mb, totales.oMb, "Margen", "#1E3A5F", "%")}
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
      ${kpiVsObj(totales.promo, totales.oPromo, "Promo", "#7C3AED", "€")}
      ${kpiVsObj(totales.liq, totales.oLiq, "Liquidación", "#D97706", "€")}
    </div>`;

  // Actividad KPIs
  html += `<p style="${S.hdr}">📊 Actividad</p>
    <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:16px">
      ${kpiSimple(totales.visitasReal + (totales.visitasRuta > 0 ? "/" + totales.visitasRuta : ""), "Visitas"+(totales.visitasRuta>0?" vs ruta":""), "#22C55E")}
      ${kpiSimple(totales.clientesNuevos, "Clientes nuevos", "#0EA5E9")}
      ${kpiSimple(totales.muestrasNuevas, "Muestras nuevas", "#F59E0B")}
      ${kpiSimple(totales.estrategiasNuevas, "Estrategias", "#7C3AED")}
      ${kpiSimple(totales.oportunidadesNuevas, "Oportunidades", "#1E3A5F")}
    </div>`;

  // ── Por equipo (si Director/CEO) ──
  if (totales.porEquipo) {
    html += `<p style="${S.hdr}">🏢 Por equipo</p>`;
    totales.porEquipo.forEach(eq => {
      html += `<div style="background:#F8FAFC;${S.box}display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap">
        <b style="color:#1E3A5F">${eq.equipo}</b>
        <span style="font-size:12px;color:#475569">${fN(eq.ventas)}€ ventas · ${eq.mb}% MB · ${eq.visitas} vis · ${eq.ops} ops</span>
      </div>`;
    });
  }

  // ── 2. POR VENDEDOR — Cifras ──
  html += `<p style="${S.hdr}">👥 Cifras por vendedor</p>`;
  let curEquipo = "";
  porVendedor.forEach(v => {
    if (v.equipo !== curEquipo) {
      curEquipo = v.equipo;
      html += `<div style="background:#1E3A5F;color:#fff;padding:6px 12px;border-radius:6px;margin:10px 0 6px;font-size:13px;font-weight:700">${curEquipo}</div>`;
    }
    html += `<div style="background:#F8FAFC;${S.box}">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px">
        <b style="font-size:13px;color:#1E3A5F">👤 ${v.nombre}</b>
        <span style="font-size:12px;color:#475569">${v.visitas} vis · ${v.ops} ops · ${v.est} est</span>
      </div>
      ${v.ventas > 0 ? `<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
        <span style="background:#DCFCE7;color:#166534;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700">${fN(v.ventas)}€${v.oVentas>0?" / "+fN(v.oVentas)+"€":""}</span>
        <span style="background:#DBEAFE;color:#1E3A5F;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700">${v.mb}% MB${v.oMb>0?" / "+v.oMb+"%":""}</span>
        ${v.promo>0?`<span style="background:#F3E8FF;color:#7C3AED;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:700">${fN(v.promo)}€ promo</span>`:""}
      </div>` : `<p style="margin:4px 0 0;font-size:11px;color:#94A3B8">Sin informe de ventas</p>`}
    </div>`;
  });

  // ── 3. VISITAS POR DÍA ──
  html += `<p style="${S.hdr}">📋 Visitas por día</p>`;
  const vDias = porDia.visitas;
  if (Object.keys(vDias).length === 0) html += `<p style="font-size:12px;color:#94A3B8;margin:8px 0">Sin visitas esta semana</p>`;
  else Object.keys(vDias).forEach(dia => {
    html += renderDayHeader(dia);
    vDias[dia].forEach(v => { html += renderVisitaDetalle(v, true); });
  });

  // ── 4. MUESTRAS POR DÍA ──
  html += `<p style="${S.hdr}">📦 Muestras</p>`;
  const mNuevas = porDia.muestrasNuevas, mResueltas = porDia.muestrasResueltas;
  if (mNuevas.length === 0 && mResueltas.length === 0) html += `<p style="font-size:12px;color:#94A3B8;margin:8px 0">Sin actividad de muestras</p>`;
  else {
    if (mNuevas.length > 0) {
      html += `<p style="margin:8px 0 4px;font-size:13px;font-weight:700;color:#F59E0B">🆕 Nuevas (${mNuevas.length})</p>`;
      const mND = groupByDay(mNuevas, "fecha");
      Object.keys(mND).forEach(dia => {
        html += renderDayHeader(dia);
        mND[dia].forEach(m => {
          html += `<div style="border-left:3px solid #F59E0B;padding:4px 0 4px 10px;margin-bottom:4px"><p style="margin:0;font-size:12px"><b>${m.cliente||"—"}</b> — ${m.prod||m.tipo||"?"} <span style="color:#64748B">(${m.agente||""})</span></p></div>`;
        });
      });
    }
    if (mResueltas.length > 0) {
      html += `<p style="margin:12px 0 4px;font-size:13px;font-weight:700;color:#22C55E">✅ Resueltas (${mResueltas.length})</p>`;
      mResueltas.forEach(m => {
        const icon = m.estado === "pedido" || m.estado === "positivo" ? "✅" : "❌";
        html += `<div style="padding:2px 0 2px 10px;margin-bottom:2px"><p style="margin:0;font-size:12px">${icon} <b>${m.cliente||"—"}</b> — ${m.prod||m.tipo||"?"} → ${m.estado||"?"} <span style="color:#64748B">(${m.agente||""})</span></p></div>`;
      });
    }
  }

  // ── 5. HITOS ──
  html += `<p style="${S.hdr}">🏗️ Hitos de proyectos</p>`;
  const { hitosTerminados, hitosPendientes } = porDia;
  if (hitosTerminados.length === 0 && hitosPendientes.length === 0) html += `<p style="font-size:12px;color:#94A3B8;margin:8px 0">Sin hitos esta semana</p>`;
  else {
    if (hitosTerminados.length > 0) {
      html += `<p style="margin:8px 0 4px;font-size:13px;font-weight:700;color:#22C55E">✅ Completados (${hitosTerminados.length})</p>`;
      const hTD = groupByDay(hitosTerminados, "fechaHecho");
      Object.keys(hTD).forEach(dia => {
        html += renderDayHeader(dia);
        hTD[dia].forEach(h => {
          html += `<div style="padding:4px 0 4px 10px;margin-bottom:4px;border-left:3px solid #22C55E"><p style="margin:0;font-size:12px"><b>${h.nombre}</b> <span style="color:#64748B">· ${h.proyecto} (${h.responsable||""})</span></p></div>`;
        });
      });
    }
    if (hitosPendientes.length > 0) {
      html += `<p style="margin:12px 0 4px;font-size:13px;font-weight:700;color:#EF4444">⏳ Pendientes / Pospuestos (${hitosPendientes.length})</p>`;
      hitosPendientes.forEach(h => {
        const vencido = h.vencido;
        html += `<div style="padding:4px 0 4px 10px;margin-bottom:4px;border-left:3px solid ${vencido?"#EF4444":"#F59E0B"}"><p style="margin:0;font-size:12px">${vencido?"🔴":"🟡"} <b>${h.nombre}</b> <span style="color:#64748B">· ${h.proyecto} · ${h.fecha||"sin fecha"} (${h.responsable||""})</span></p></div>`;
      });
    }
  }

  // ── 6. ESTRATEGIAS ──
  html += `<p style="${S.hdr}">🎯 Estrategias</p>`;
  const { estNuevas, estResueltas } = porDia;
  if (estNuevas.length === 0 && estResueltas.length === 0) html += `<p style="font-size:12px;color:#94A3B8;margin:8px 0">Sin estrategias esta semana</p>`;
  else {
    if (estNuevas.length > 0) {
      html += `<p style="margin:8px 0 4px;font-size:13px;font-weight:700;color:#7C3AED">🆕 Nuevas (${estNuevas.length})</p>`;
      const eND = groupByDay(estNuevas, "fecha");
      Object.keys(eND).forEach(dia => {
        html += renderDayHeader(dia);
        eND[dia].forEach(e => {
          html += `<div style="border-left:3px solid #7C3AED;padding:4px 0 4px 10px;margin-bottom:4px"><p style="margin:0;font-size:12px"><b>${e.clienteNombre||e.cliente||"—"}</b> — ${e.tipo||"?"}: ${e.objetivo||e.texto||""} <span style="color:#64748B">(${e.agenteNombre||e.creadoPor||""})</span></p></div>`;
        });
      });
    }
    if (estResueltas.length > 0) {
      html += `<p style="margin:12px 0 4px;font-size:13px;font-weight:700;color:#22C55E">✅ Resueltas (${estResueltas.length})</p>`;
      estResueltas.forEach(e => {
        html += `<div style="padding:2px 0 2px 10px;margin-bottom:2px"><p style="margin:0;font-size:12px">✅ <b>${e.clienteNombre||e.cliente||"—"}</b> — ${e.resultado||e.estado||"?"} <span style="color:#64748B">(${e.agenteNombre||e.creadoPor||""})</span></p></div>`;
      });
    }
  }

  // ── 7. OPORTUNIDADES ──
  html += `<p style="${S.hdr}">💼 Oportunidades</p>`;
  const { opsResueltas, opsNuevas } = porDia;
  if (opsResueltas.length === 0 && opsNuevas.length === 0) html += `<p style="font-size:12px;color:#94A3B8;margin:8px 0">Sin oportunidades esta semana</p>`;
  else {
    if (opsResueltas.length > 0) {
      html += `<p style="margin:8px 0 4px;font-size:13px;font-weight:700;color:#22C55E">✅ Resueltas (${opsResueltas.length})</p>`;
      opsResueltas.forEach(o => {
        const icon = o.estado === "ganada" ? "🏆" : o.estado === "perdida" ? "❌" : "✅";
        html += `<div style="padding:2px 0 2px 10px;margin-bottom:2px"><p style="margin:0;font-size:12px">${icon} <b>${o.cliente||o.nombre||"—"}</b> — ${fN(o.valor||0)}€ (${o.estado||"?"}) <span style="color:#64748B">(${o.agente||""})</span></p></div>`;
      });
    }
    if (opsNuevas.length > 0) {
      html += `<p style="margin:12px 0 4px;font-size:13px;font-weight:700;color:#1E3A5F">🆕 Nuevas pendientes (${opsNuevas.length})</p>`;
      opsNuevas.forEach(o => {
        html += `<div style="padding:2px 0 2px 10px;margin-bottom:2px;border-left:3px solid #1E3A5F"><p style="margin:0;font-size:12px"><b>${o.cliente||o.nombre||"—"}</b> — ${fN(o.valor||0)}€ (${o.estado||o.etapa||"pendiente"}) <span style="color:#64748B">(${o.agente||""})</span></p></div>`;
      });
    }
  }

  // Footer
  html += `<p style="margin:24px 0 0;text-align:center"><a href="https://crmwikuk.vercel.app" style="display:inline-block;background:#1E3A5F;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">Abrir CRM</a></p>
    <p style="margin:20px 0 0;font-size:10px;color:#94A3B8;text-align:center">Grupo Consolidado · Informe automático · Semana ${semana}</p>
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
    const hoy = new Date();
    const hoyStr = hoy.toISOString().split("T")[0];

    // ── Leer todas las colecciones necesarias ──
    const [usuarios, visitas, oportunidades, estrategias, incidencias, muestras, informes, presupuesto, monetizacion, proyectos, clientes, planes] = await Promise.all([
      fbList("usuarios"), fbList("visitas"), fbList("oportunidades"),
      fbList("estrategias"), fbList("incidencias"), fbList("muestras"),
      fbList("informes"), fbList("presupuesto"), fbList("monetizacion"),
      fbList("proyectos"), fbList("clientes"), fbList("planes_semanales"),
    ]);

    // ── Filtrar por semana ──
    const noElim = arr => arr.filter(x => !x.eliminada);
    const visSem = noElim(visitas).filter(x => enSemana(x, semana, lu, vi));
    const opsSem = noElim(oportunidades).filter(x => enSemana(x, semana, lu, vi));
    const estSem = noElim(estrategias).filter(x => enSemana(x, semana, lu, vi));
    const incSem = noElim(incidencias).filter(x => enSemana(x, semana, lu, vi));
    const mueSem = noElim(muestras).filter(x => enSemana(x, semana, lu, vi));
    const infSem = informes.filter(i => parseInt(i.semana) === semana);
    const cliNuevos = noElim(clientes).filter(c => c.esNuevo && enSemana(c, semana, lu, vi));

    // ── Objetivos por agente (presupuesto + monetizacion) ──
    function getObjetivos(agId, grupoAgente) {
      const grp = (grupoAgente || "").toUpperCase();
      const matchDoc = d => {
        if (parseInt(d.semana || d.SEMANA) !== semana) return false;
        const a = parseInt(d.ano || d.AÑO || d.anio || 0);
        if (a !== hoy.getFullYear()) return false;
        const ag = String(d.agente || d.COMERCIAL || "").toUpperCase();
        return ag === agId.toUpperCase() || ag === grp || ag === String(d.crmId || "").toUpperCase();
      };
      const pDoc = presupuesto.find(matchDoc);
      const mDoc = monetizacion.find(matchDoc);
      const n = (d, ...keys) => { if (!d) return 0; for (const k of keys) { const v = d[k]; if (v !== undefined && v !== null && v !== "") { const x = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.\-]/g,"")); if (!isNaN(x)) return x; } } return 0; };
      return {
        oVentas: n(pDoc, "ventasPpto", "VENTAS PPTO.", "VENTAS PPTO"),
        oMb: (() => { const x = n(pDoc, "mgPpto", "MG PPTO"); return x > 0 && x < 1 ? +(x*100).toFixed(1) : x; })(),
        oPromo: n(mDoc, "promoObjetivo", "PROMO OBJETIVO"),
        oLiq: n(mDoc, "liquidObjetivo", "LIQUID. OBJETIVO", "LIQUID OBJETIVO"),
      };
    }

    // ── Hitos de proyectos ──
    const hitosTerminados = [], hitosPendientes = [];
    const luStr = lu.toISOString().split("T")[0];
    const viStr = vi.toISOString().split("T")[0];
    noElim(proyectos).filter(p => p.estado === "activo").forEach(p => {
      (p.hitos || []).forEach(h => {
        if (typeof h !== "object" || !h) return;
        const f = h.fecha || "";
        const fISO = f.includes("/") ? f.split("/").reverse().join("-") : f;
        if (h.hecho) {
          const fH = h.fechaHecho || h.fecha || "";
          const fHISO = fH.includes("/") ? fH.split("/").reverse().join("-") : fH;
          if (fHISO >= luStr && fHISO <= viStr) hitosTerminados.push({ nombre: h.nombre || "Sin nombre", proyecto: p.nombre || "", responsable: h.responsable || "", fechaHecho: fH });
        } else {
          if ((fISO >= luStr && fISO <= viStr) || (fISO && fISO < hoyStr)) {
            hitosPendientes.push({ nombre: h.nombre || "Sin nombre", proyecto: p.nombre || "", responsable: h.responsable || "", fecha: f, vencido: fISO < hoyStr });
          }
        }
      });
    });

    // ── Muestras: nuevas vs resueltas ──
    const muestrasNuevas = mueSem.filter(m => !m.fechaFeedback || m.estadoMuestra === "PENDIENTE DE ENVIAR" || m.estadoMuestra === "ENVIADO");
    const muestrasResueltas = mueSem.filter(m => m.fechaFeedback && (m.estado === "pedido" || m.estado === "positivo" || m.estado === "ko"));

    // ── Estrategias: nuevas vs resueltas ──
    const estNuevas = estSem.filter(e => !e.resultado || e.estado === "pendiente" || e.estado === "pendiente_aprobacion" || e.estado === "activa");
    const estResueltas = estSem.filter(e => e.resultado && e.resultado !== "" && (e.estado === "cerrada" || e.estado === "resuelta" || e.resultado === "pedido" || e.resultado === "mas_dto" || e.resultado === "descartada"));

    // ── Oportunidades: resueltas vs nuevas pendientes ──
    const opsResueltas = opsSem.filter(o => o.estado === "ganada" || o.estado === "perdida" || o.estado === "cerrada");
    const opsNuevas = opsSem.filter(o => o.estado !== "ganada" && o.estado !== "perdida" && o.estado !== "cerrada");

    // ── Visitas vs ruta ──
    const planesSem = planes.filter(p => parseInt(p.semana) === semana);

    // ── SMTP ──
    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    const sent = [], errors = [];

    // ── Helpers ──
    function idsDeAg(ag) {
      const ids = new Set();
      ["id","grupoAgente","nombre","username"].forEach(k => { if (ag[k]) ids.add(String(ag[k]).toUpperCase()); });
      return ids;
    }

    // ── MANAGERS ──
    const managers = usuarios.filter(u => ["jefe","director","ceo"].includes(u.rol) && u.email);
    for (const mg of managers) {
      const esJefe = mg.rol === "jefe";
      const agentesScope = usuarios.filter(u => (u.rol === "agente" || u.rol === "crm_agente") && (esJefe ? u.equipo === mg.equipo : true));
      const allIds = new Set();
      agentesScope.forEach(u => idsDeAg(u).forEach(id => allIds.add(id)));

      const scopeFilter = arr => arr.filter(x => perteneceA(x, allIds));

      // Ventas totales del scope
      let totalVentas = 0, totalPromo = 0, totalLiq = 0, sumMb = 0, countMb = 0;
      let totalOVentas = 0, totalOPromo = 0, totalOLiq = 0, sumOMb = 0;

      const porVendedor = agentesScope.map(ag => {
        const ids = idsDeAg(ag);
        const usr = usuarios.find(u => u.id === ag.id);
        const grp = usr ? (usr.grupoAgente || "") : "";
        const inf = infSem.find(i => i.agente === ag.id || i.agenteId === ag.id);
        const obj = getObjetivos(ag.id, grp);
        const v = inf ? (Number(inf.ventas) || Number(inf.venta) || 0) : 0;
        const m = inf ? (Number(inf.mb) || 0) : 0;
        const p = inf ? (Number(inf.promo) || 0) : 0;
        const l = inf ? (Number(inf.liq) || 0) : 0;
        totalVentas += v; totalPromo += p; totalLiq += l;
        if (m > 0) { sumMb += m; countMb++; }
        totalOVentas += obj.oVentas; totalOPromo += obj.oPromo; totalOLiq += obj.oLiq;
        if (obj.oMb > 0) sumOMb += obj.oMb;

        return {
          nombre: ag.nombre || ag.id, equipo: ag.equipo || "SIN EQUIPO",
          ventas: v, mb: m, promo: p, liq: l,
          oVentas: obj.oVentas, oMb: obj.oMb,
          visitas: scopeFilter(visSem).filter(x => perteneceA(x, ids)).length,
          ops: scopeFilter(opsSem).filter(x => perteneceA(x, ids)).length,
          est: scopeFilter(estSem).filter(x => perteneceA(x, ids)).length,
        };
      }).sort((a, b) => b.ventas - a.ventas || b.visitas - a.visitas);

      // Por equipo (solo director/ceo)
      let porEquipo = null;
      if (!esJefe) {
        porEquipo = ["WIKUK", "INTERKEY"].map(eq => {
          const idsEq = new Set();
          usuarios.filter(u => (u.rol === "agente" || u.rol === "crm_agente") && u.equipo === eq).forEach(u => idsDeAg(u).forEach(id => idsEq.add(id)));
          const vEq = infSem.filter(i => idsEq.has(String(i.agente || "").toUpperCase())).reduce((s, i) => s + (Number(i.ventas) || Number(i.venta) || 0), 0);
          const mEq = infSem.filter(i => idsEq.has(String(i.agente || "").toUpperCase()));
          const mbArr = mEq.map(i => Number(i.mb) || 0).filter(x => x > 0);
          return {
            equipo: eq, ventas: vEq,
            mb: mbArr.length > 0 ? Math.round(mbArr.reduce((s, x) => s + x, 0) / mbArr.length * 10) / 10 : 0,
            visitas: scopeFilter(visSem).filter(x => perteneceA(x, idsEq)).length,
            ops: scopeFilter(opsSem).filter(x => perteneceA(x, idsEq)).length,
          };
        });
      }

      // Visitas vs ruta
      const visitasRuta = planesSem.filter(p => allIds.has(String(p.agente || "").toUpperCase()) && p.rutaNum).length > 0
        ? planesSem.filter(p => allIds.has(String(p.agente || "").toUpperCase())).reduce((s, p) => {
            const cliRuta = clientes.filter(c => {
              const r = Number(c.ruta || c.RUTA || c.numRuta || 0);
              return r === Number(p.rutaNum);
            });
            return s + cliRuta.length;
          }, 0) : 0;

      const ctx = {
        titulo: esJefe ? `Equipo ${mg.equipo} · Semana ${semana}` : `Informe consolidado · Semana ${semana}`,
        nombre: mg.nombre, semana, lu, vi,
        totales: {
          ventas: totalVentas, oVentas: totalOVentas,
          mb: countMb > 0 ? Math.round(sumMb / countMb * 10) / 10 : 0,
          oMb: countMb > 0 ? Math.round(sumOMb / countMb * 10) / 10 : 0,
          promo: totalPromo, oPromo: totalOPromo,
          liq: totalLiq, oLiq: totalOLiq,
          visitasReal: scopeFilter(visSem).length, visitasRuta,
          clientesNuevos: cliNuevos.filter(c => perteneceA(c, allIds) || !esJefe).length,
          muestrasNuevas: muestrasNuevas.filter(m => perteneceA(m, allIds) || !esJefe).length,
          estrategiasNuevas: estNuevas.filter(e => perteneceA(e, allIds) || !esJefe).length,
          oportunidadesNuevas: opsNuevas.filter(o => perteneceA(o, allIds) || !esJefe).length,
          porEquipo,
        },
        porVendedor,
        porDia: {
          visitas: groupByDay(scopeFilter(visSem), "fecha"),
          muestrasNuevas: muestrasNuevas.filter(m => perteneceA(m, allIds) || !esJefe),
          muestrasResueltas: muestrasResueltas.filter(m => perteneceA(m, allIds) || !esJefe),
          hitosTerminados, hitosPendientes,
          estNuevas: estNuevas.filter(e => perteneceA(e, allIds) || !esJefe),
          estResueltas: estResueltas.filter(e => perteneceA(e, allIds) || !esJefe),
          opsResueltas: opsResueltas.filter(o => perteneceA(o, allIds) || !esJefe),
          opsNuevas: opsNuevas.filter(o => perteneceA(o, allIds) || !esJefe),
        },
      };

      const html = buildEmailDirector(ctx);
      try {
        await transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: mg.email, subject: `📊 Informe semana ${semana}${esJefe ? " · " + mg.equipo : ""}`, html });
        sent.push({ tipo: mg.rol, nombre: mg.nombre, email: mg.email });
      } catch (err) { errors.push({ tipo: mg.rol, email: mg.email, error: err.message }); }
    }

    // ── AGENTES (versión simplificada) ──
    const agentes = usuarios.filter(u => (u.rol === "agente" || u.rol === "crm_agente") && u.email);
    for (const ag of agentes) {
      const ids = idsDeAg(ag);
      const inf = infSem.find(i => i.agente === ag.id);
      const obj = getObjetivos(ag.id, ag.grupoAgente || "");
      const misVis = visSem.filter(x => perteneceA(x, ids));
      const misOps = opsSem.filter(x => perteneceA(x, ids));
      const misEst = estSem.filter(x => perteneceA(x, ids));
      const misMue = mueSem.filter(x => perteneceA(x, ids));
      const v = inf ? (Number(inf.ventas)||Number(inf.venta)||0) : 0;
      const m = inf ? (Number(inf.mb)||0) : 0;
      const p = inf ? (Number(inf.promo)||0) : 0;

      const ctx = {
        titulo: "Tu cierre de semana",
        nombre: ag.nombre, semana, lu, vi,
        totales: {
          ventas: v, oVentas: obj.oVentas, mb: m, oMb: obj.oMb,
          promo: p, oPromo: obj.oPromo, liq: inf?(Number(inf.liq)||0):0, oLiq: obj.oLiq,
          visitasReal: misVis.length, visitasRuta: 0,
          clientesNuevos: cliNuevos.filter(c => perteneceA(c, ids)).length,
          muestrasNuevas: misMue.filter(x => !x.fechaFeedback).length,
          estrategiasNuevas: misEst.length,
          oportunidadesNuevas: misOps.length,
          porEquipo: null,
        },
        porVendedor: [],
        porDia: {
          visitas: groupByDay(misVis, "fecha"),
          muestrasNuevas: misMue.filter(x => !x.fechaFeedback),
          muestrasResueltas: misMue.filter(x => x.fechaFeedback),
          hitosTerminados: hitosTerminados.filter(h => ids.has((h.responsable||"").toUpperCase())),
          hitosPendientes: hitosPendientes.filter(h => ids.has((h.responsable||"").toUpperCase())),
          estNuevas: misEst.filter(e => !e.resultado),
          estResueltas: misEst.filter(e => e.resultado),
          opsResueltas: misOps.filter(o => ["ganada","perdida","cerrada"].includes(o.estado)),
          opsNuevas: misOps.filter(o => !["ganada","perdida","cerrada"].includes(o.estado)),
        },
      };

      const html = buildEmailDirector(ctx);
      try {
        await transporter.sendMail({ from: process.env.SMTP_FROM||process.env.SMTP_USER, to: ag.email, subject: `📊 Tu semana ${semana} · ${ag.nombre||ag.id}`, html });
        sent.push({ tipo:"agente", nombre:ag.nombre, email:ag.email });
      } catch(err) { errors.push({ tipo:"agente", email:ag.email, error:err.message }); }
    }

    return res.status(200).json({
      ok: true, semana,
      rango: { lunes: lu.toISOString(), viernes: vi.toISOString() },
      totales: { visitas: visSem.length, ops: opsSem.length, est: estSem.length, inc: incSem.length, mue: mueSem.length, informes: infSem.length, hitos: hitosTerminados.length + hitosPendientes.length, clientesNuevos: cliNuevos.length },
      sent, errors,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, stack: err.stack });
  }
}
