// /api/weekly-summary.js  —  v5
// 6 fixes: rutas, estrategias count, equipo objectives, vendedor detail, agent names, ops resueltas

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
  for (const k of ["fecha","fechaCreacion","creadoEn","fechaAlta","creadaEn"]) { const d = parseFecha(item[k]); if (d && d >= lu && d <= vi) return true; }
  return false;
}
function pertA(item, ids) {
  return ids.has(String(item.agente||item.agenteId||item.autor||item.creadoPor||item.responsable||"").toUpperCase());
}
const DIAS = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
function diaKey(fecha) { const d = parseFecha(fecha); if (!d) return "Sin fecha"; return `${DIAS[d.getDay()]} ${d.getDate()}/${d.getMonth()+1}`; }
function colorR(r) { return {visitado:"#22C55E",nuevo_pedido:"#16A34A",seguimiento:"#3B82F6",llamada:"#8B5CF6",no_disponible:"#F59E0B",no_compra:"#EF4444",sin_contacto:"#94A3B8"}[r]||"#64748B"; }
function labelR(r) { return {visitado:"Visitado",nuevo_pedido:"Nuevo pedido",seguimiento:"Seguimiento",llamada:"Llamada",no_disponible:"No disponible",no_compra:"No compra",sin_contacto:"Sin contacto"}[r]||(r||"—"); }

function groupByDay(items, fechaField) {
  const groups = {}, order = ["Lunes","Martes","Miércoles","Jueves","Viernes"];
  items.forEach(item => {
    const dk = diaKey(item[fechaField]||item.fecha||item.fechaCreacion||item.creadoEn||item.creadaEn||item.fechaAlta);
    if (!groups[dk]) groups[dk] = []; groups[dk].push(item);
  });
  const sorted = {}, keys = Object.keys(groups).sort((a,b) => {
    const da = order.findIndex(d => a.startsWith(d)), db = order.findIndex(d => b.startsWith(d));
    return (da===-1?99:da) - (db===-1?99:db);
  });
  keys.forEach(k => sorted[k] = groups[k]); return sorted;
}

// ── HTML helpers ──
const S = { hdr: "margin:24px 0 10px;font-size:15px;font-weight:800;color:#1E3A5F;border-bottom:2px solid #E2E8F0;padding-bottom:6px;" };

function kpiVsObj(val, obj, label, color, unit) {
  const pct = obj > 0 ? Math.round(val / obj * 100) : null;
  const pctC = pct === null ? "#94A3B8" : pct >= 100 ? "#22C55E" : pct >= 70 ? "#F59E0B" : "#EF4444";
  return `<div style="flex:1;min-width:120px;background:${color}10;border:1px solid ${color}30;border-radius:10px;padding:12px;text-align:center">
    <p style="margin:0;font-size:20px;font-weight:800;color:${color}">${fN(val)}${unit}</p>
    ${obj > 0 ? `<p style="margin:2px 0 0;font-size:11px;color:#64748B">obj: ${fN(obj)}${unit}</p><p style="margin:2px 0 0;font-size:13px;font-weight:700;color:${pctC}">${pct}%</p>` : `<p style="margin:2px 0 0;font-size:11px;color:#94A3B8">${label}</p>`}
  </div>`;
}
function kpiSimple(val, label, color) {
  return `<div style="flex:1;min-width:70px;background:${color}15;border-radius:10px;padding:10px;text-align:center"><p style="margin:0;font-size:20px;font-weight:800;color:${color}">${val}</p><p style="margin:0;font-size:10px;color:#64748B">${label}</p></div>`;
}
function dayHdr(dia) { return `<div style="background:#1E3A5F;color:#fff;padding:6px 12px;border-radius:6px;margin:12px 0 6px;font-size:12px;font-weight:700">📅 ${dia}</div>`; }

// FIX 5: renderVisita receives nombreMap to resolve agent names
function renderVis(v, showAgent, nombreMap) {
  const agName = showAgent ? (nombreMap[String(v.agente||v.agenteId||v.creadoPor||"").toUpperCase()] || v.creadoPorNombre || v.agente || "") : "";
  return `<div style="border-left:3px solid ${colorR(v.resultado)};padding:6px 0 6px 10px;margin-bottom:6px;background:#FAFAFA;border-radius:0 6px 6px 0">
    <p style="margin:0;font-size:13px;font-weight:600;color:#0F172A">${v.clienteNombre||v.cliente||"—"}${showAgent?` <span style="color:#64748B;font-weight:400;font-size:11px">(${agName})</span>`:""}</p>
    <p style="margin:2px 0 0;font-size:11px;color:#64748B"><span style="color:${colorR(v.resultado)};font-weight:600">${labelR(v.resultado)}</span>${v.ciudad?" · "+v.ciudad:""}${v.contacto?" · "+v.contacto:""}</p>
    ${v.nota||v.notas?`<p style="margin:3px 0 0;font-size:11px;color:#475569;line-height:1.4">${(v.nota||v.notas).substring(0,250)}${(v.nota||v.notas||"").length>250?"...":""}</p>`:""}
  </div>`;
}

// ── Equipo/vendedor row with full objectives ──
function renderEquipoRow(label, d) {
  const pctV = d.oV > 0 ? Math.round(d.v / d.oV * 100) : null;
  const pctVc = pctV === null ? "" : pctV >= 100 ? "🟢" : pctV >= 70 ? "🟡" : "🔴";
  return `<div style="background:#F8FAFC;border-radius:10px;padding:12px 14px;margin-bottom:8px;border:1px solid #E2E8F0">
    <p style="margin:0;font-weight:700;font-size:14px;color:#1E3A5F">${label}</p>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
      <span style="background:#DCFCE7;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;color:#166534">💰 ${fN(d.v)}€${d.oV>0?" / "+fN(d.oV)+"€ "+pctVc:""}</span>
      <span style="background:#DBEAFE;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;color:#1E3A5F">📊 ${d.mb}%${d.oMb>0?" / "+d.oMb+"%":""}</span>
      ${d.promo>0||d.oPromo>0?`<span style="background:#F3E8FF;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;color:#7C3AED">🎯 ${fN(d.promo)}€${d.oPromo>0?" / "+fN(d.oPromo)+"€":""}</span>`:""}
      ${d.liq>0||d.oLiq>0?`<span style="background:#FEF3C7;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;color:#92400E">📤 ${fN(d.liq)}€${d.oLiq>0?" / "+fN(d.oLiq)+"€":""}</span>`:""}
    </div>
    <p style="margin:6px 0 0;font-size:11px;color:#475569">${d.vis}${d.visR>0?" / "+d.visR:""} visitas · ${d.ops} ops · ${d.est} est · ${d.mue} mue</p>
  </div>`;
}

// ══════════════════════════════════════════════════════════
// BUILD EMAIL
// ══════════════════════════════════════════════════════════
function buildEmail(ctx) {
  const { titulo, nombre, semana, lu, vi, totales, porEquipo, porVendedor, porDia, nombreMap } = ctx;
  const fD = d => d.toLocaleDateString("es-ES", { day:"2-digit", month:"short" });

  let html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#F0F4F8;padding:16px;color:#0F172A">
  <div style="max-width:680px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#1E3A5F,#3B82F6);color:#fff;padding:24px 20px">
      <p style="margin:0;font-size:13px;opacity:.8">📅 Semana ${semana} · ${fD(lu)} → ${fD(vi)}</p>
      <h1 style="margin:6px 0 0;font-size:22px">${titulo}</h1>
    </div>
    <div style="padding:20px">
    <p style="margin:0 0 16px;font-size:15px">Hola <b>${nombre}</b>, aquí tienes el informe completo:</p>`;

  // 1. RESULTADOS ECONÓMICOS
  html += `<p style="${S.hdr}">💰 Resultados económicos</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">${kpiVsObj(totales.ventas,totales.oVentas,"Ventas","#166534","€")}${kpiVsObj(totales.mb,totales.oMb,"Margen","#1E3A5F","%")}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">${kpiVsObj(totales.promo,totales.oPromo,"Promo","#7C3AED","€")}${kpiVsObj(totales.liq,totales.oLiq,"Liquidación","#D97706","€")}</div>`;

  // 2. ACTIVIDAD - FIX 2: estrategias = total (not just new)
  html += `<p style="${S.hdr}">📊 Actividad</p>
    <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:16px">
      ${kpiSimple(totales.visitasReal+(totales.visitasRuta>0?"/"+totales.visitasRuta:""),"Visitas"+(totales.visitasRuta>0?" vs ruta":""),"#22C55E")}
      ${kpiSimple(totales.clientesNuevos,"Clientes nuevos","#0EA5E9")}
      ${kpiSimple(totales.muestrasNuevas,"Muestras nuevas","#F59E0B")}
      ${kpiSimple(totales.estrategias,"Estrategias","#7C3AED")}
      ${kpiSimple(totales.oportunidades,"Oportunidades","#1E3A5F")}
    </div>`;

  // 3. POR EQUIPO - FIX 3: full objectives
  if (porEquipo && porEquipo.length > 0) {
    html += `<p style="${S.hdr}">🏢 Por equipo</p>`;
    porEquipo.forEach(eq => { html += renderEquipoRow("📦 " + eq.equipo, eq); });
  }

  // 4. POR VENDEDOR - FIX 4: same detail as equipo
  if (porVendedor && porVendedor.length > 0) {
    html += `<p style="${S.hdr}">👥 Por vendedor</p>`;
    let curEq = "";
    porVendedor.forEach(v => {
      if (v.equipo !== curEq) { curEq = v.equipo; html += `<div style="background:#1E3A5F;color:#fff;padding:6px 12px;border-radius:6px;margin:10px 0 6px;font-size:13px;font-weight:700">${curEq}</div>`; }
      html += renderEquipoRow("👤 " + v.nombre, v);
    });
  }

  // 5. VISITAS POR DÍA - FIX 5: agent name
  html += `<p style="${S.hdr}">📋 Visitas por día</p>`;
  const vD = porDia.visitas;
  if (Object.keys(vD).length === 0) html += `<p style="font-size:12px;color:#94A3B8;margin:8px 0">Sin visitas esta semana</p>`;
  else Object.keys(vD).forEach(dia => { html += dayHdr(dia); vD[dia].forEach(v => { html += renderVis(v, true, nombreMap); }); });

  // 6. MUESTRAS
  html += `<p style="${S.hdr}">📦 Muestras</p>`;
  const { mNuevas, mResueltas } = porDia;
  if (mNuevas.length === 0 && mResueltas.length === 0) html += `<p style="font-size:12px;color:#94A3B8;margin:8px 0">Sin actividad de muestras</p>`;
  else {
    if (mNuevas.length > 0) {
      html += `<p style="margin:8px 0 4px;font-size:13px;font-weight:700;color:#F59E0B">🆕 Nuevas (${mNuevas.length})</p>`;
      const mND = groupByDay(mNuevas, "fecha");
      Object.keys(mND).forEach(dia => { html += dayHdr(dia); mND[dia].forEach(m => {
        html += `<div style="border-left:3px solid #F59E0B;padding:4px 0 4px 10px;margin-bottom:4px"><p style="margin:0;font-size:12px"><b>${m.cliente||"—"}</b> — ${m.prod||m.tipo||"?"} <span style="color:#64748B">(${nombreMap[String(m.agente||"").toUpperCase()]||m.agente||""})</span></p></div>`;
      }); });
    }
    if (mResueltas.length > 0) {
      html += `<p style="margin:12px 0 4px;font-size:13px;font-weight:700;color:#22C55E">✅ Resueltas (${mResueltas.length})</p>`;
      mResueltas.forEach(m => {
        const ic = m.estado==="pedido"||m.estado==="positivo"?"✅":"❌";
        html += `<div style="padding:2px 0 2px 10px;margin-bottom:2px"><p style="margin:0;font-size:12px">${ic} <b>${m.cliente||"—"}</b> — ${m.prod||m.tipo||"?"} → ${m.estado||"?"} <span style="color:#64748B">(${nombreMap[String(m.agente||"").toUpperCase()]||m.agente||""})</span></p></div>`;
      });
    }
  }

  // 7. HITOS
  html += `<p style="${S.hdr}">🏗️ Hitos de proyectos</p>`;
  const { hitosOk, hitosPend } = porDia;
  if (hitosOk.length === 0 && hitosPend.length === 0) html += `<p style="font-size:12px;color:#94A3B8;margin:8px 0">Sin hitos esta semana</p>`;
  else {
    if (hitosOk.length > 0) {
      html += `<p style="margin:8px 0 4px;font-size:13px;font-weight:700;color:#22C55E">✅ Completados (${hitosOk.length})</p>`;
      const hD = groupByDay(hitosOk, "fechaHecho");
      Object.keys(hD).forEach(dia => { html += dayHdr(dia); hD[dia].forEach(h => {
        html += `<div style="padding:4px 0 4px 10px;margin-bottom:4px;border-left:3px solid #22C55E"><p style="margin:0;font-size:12px"><b>${h.nombre}</b> <span style="color:#64748B">· ${h.proyecto} (${nombreMap[String(h.responsable||"").toUpperCase()]||h.responsable||""})</span></p></div>`;
      }); });
    }
    if (hitosPend.length > 0) {
      html += `<p style="margin:12px 0 4px;font-size:13px;font-weight:700;color:#EF4444">⏳ Pendientes / Pospuestos (${hitosPend.length})</p>`;
      hitosPend.forEach(h => {
        html += `<div style="padding:4px 0 4px 10px;margin-bottom:4px;border-left:3px solid ${h.vencido?"#EF4444":"#F59E0B"}"><p style="margin:0;font-size:12px">${h.vencido?"🔴":"🟡"} <b>${h.nombre}</b> <span style="color:#64748B">· ${h.proyecto} · ${h.fecha||"sin fecha"} (${nombreMap[String(h.responsable||"").toUpperCase()]||h.responsable||""})</span></p></div>`;
      });
    }
  }

  // 8. ESTRATEGIAS
  html += `<p style="${S.hdr}">🎯 Estrategias</p>`;
  const { estNew, estDone } = porDia;
  if (estNew.length === 0 && estDone.length === 0) html += `<p style="font-size:12px;color:#94A3B8;margin:8px 0">Sin estrategias esta semana</p>`;
  else {
    if (estNew.length > 0) {
      html += `<p style="margin:8px 0 4px;font-size:13px;font-weight:700;color:#7C3AED">🆕 Nuevas / Activas (${estNew.length})</p>`;
      const eD = groupByDay(estNew, "fecha");
      Object.keys(eD).forEach(dia => { html += dayHdr(dia); eD[dia].forEach(e => {
        html += `<div style="border-left:3px solid #7C3AED;padding:4px 0 4px 10px;margin-bottom:4px"><p style="margin:0;font-size:12px"><b>${e.clienteNombre||e.cliente||"—"}</b> — ${e.tipo||"?"}: ${e.objetivo||e.texto||""} <span style="color:#64748B">(${e.agenteNombre||nombreMap[String(e.creadoPor||e.agente||"").toUpperCase()]||e.creadoPor||""})</span></p></div>`;
      }); });
    }
    if (estDone.length > 0) {
      html += `<p style="margin:12px 0 4px;font-size:13px;font-weight:700;color:#22C55E">✅ Resueltas (${estDone.length})</p>`;
      estDone.forEach(e => {
        html += `<div style="padding:2px 0 2px 10px;margin-bottom:2px"><p style="margin:0;font-size:12px">✅ <b>${e.clienteNombre||e.cliente||"—"}</b> — ${e.resultado||e.estado||"?"} <span style="color:#64748B">(${e.agenteNombre||nombreMap[String(e.creadoPor||e.agente||"").toUpperCase()]||e.creadoPor||""})</span></p></div>`;
      });
    }
  }

  // 9. OPORTUNIDADES - FIX 6: resueltas antiguas + nuevas
  html += `<p style="${S.hdr}">💼 Oportunidades</p>`;
  const { opsDone, opsNew } = porDia;
  if (opsDone.length === 0 && opsNew.length === 0) html += `<p style="font-size:12px;color:#94A3B8;margin:8px 0">Sin oportunidades</p>`;
  else {
    if (opsDone.length > 0) {
      html += `<p style="margin:8px 0 4px;font-size:13px;font-weight:700;color:#22C55E">✅ Resueltas (${opsDone.length})</p>`;
      opsDone.forEach(o => {
        const ic = o.estado==="ganada"?"🏆":o.estado==="perdida"?"❌":"✅";
        html += `<div style="padding:2px 0 2px 10px;margin-bottom:2px"><p style="margin:0;font-size:12px">${ic} <b>${o.cliente||o.nombre||"—"}</b> — ${fN(o.valor||0)}€ (${o.estado||"?"}) <span style="color:#64748B">(${nombreMap[String(o.agente||o.agenteId||"").toUpperCase()]||o.agente||""})</span></p></div>`;
      });
    }
    if (opsNew.length > 0) {
      html += `<p style="margin:12px 0 4px;font-size:13px;font-weight:700;color:#1E3A5F">🆕 Nuevas pendientes (${opsNew.length})</p>`;
      opsNew.forEach(o => {
        html += `<div style="padding:2px 0 2px 10px;margin-bottom:2px;border-left:3px solid #1E3A5F"><p style="margin:0;font-size:12px"><b>${o.cliente||o.nombre||"—"}</b> — ${fN(o.valor||0)}€ (${o.estado||o.etapa||"pendiente"}) <span style="color:#64748B">(${nombreMap[String(o.agente||o.agenteId||"").toUpperCase()]||o.agente||""})</span></p></div>`;
      });
    }
  }

  html += `<p style="margin:24px 0 0;text-align:center"><a href="https://crmwikuk.vercel.app" style="display:inline-block;background:#1E3A5F;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">Abrir CRM</a></p>
    <p style="margin:20px 0 0;font-size:10px;color:#94A3B8;text-align:center">Grupo Consolidado · Semana ${semana}</p>
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
    const hoy = new Date(), hoyStr = hoy.toISOString().split("T")[0];

    const [usuarios, visitas, oportunidades, estrategias, incidencias, muestras, informes, presupuesto, monetizacion, proyectos, clientes, planes, agentesKpi] = await Promise.all([
      fbList("usuarios"), fbList("visitas"), fbList("oportunidades"),
      fbList("estrategias"), fbList("incidencias"), fbList("muestras"),
      fbList("informes"), fbList("presupuesto"), fbList("monetizacion"),
      fbList("proyectos"), fbList("clientes"), fbList("planes_semanales"), fbList("agentes_kpi"),
    ]);

    // FIX 5: Build nombre lookup map (ID → nombre)
    const nombreMap = {};
    usuarios.forEach(u => {
      if (u.nombre) {
        nombreMap[String(u.id||"").toUpperCase()] = u.nombre;
        if (u.grupoAgente) nombreMap[String(u.grupoAgente).toUpperCase()] = u.nombre;
        if (u.username) nombreMap[String(u.username).toUpperCase()] = u.nombre;
        nombreMap[String(u.nombre).toUpperCase()] = u.nombre;
      }
    });

    const noElim = arr => arr.filter(x => !x.eliminada);
    const visSem = noElim(visitas).filter(x => enSemana(x, semana, lu, vi));
    const estSem = noElim(estrategias).filter(x => enSemana(x, semana, lu, vi));
    const incSem = noElim(incidencias).filter(x => enSemana(x, semana, lu, vi));
    const mueSem = noElim(muestras).filter(x => enSemana(x, semana, lu, vi));
    const infSem = informes.filter(i => parseInt(i.semana) === semana);
    const cliNuevos = noElim(clientes).filter(c => c.esNuevo && enSemana(c, semana, lu, vi));

    // FIX 6: Oportunidades — semana actual + TODAS las resueltas no eliminadas
    const opsSemana = noElim(oportunidades).filter(x => enSemana(x, semana, lu, vi));
    const opsResueltasAll = noElim(oportunidades).filter(o => ["ganada","perdida","cerrada"].includes(o.estado));
    const opsNuevasSem = opsSemana.filter(o => !["ganada","perdida","cerrada"].includes(o.estado));
    // Merge: resueltas = todas las resueltas (any time) + semana resueltas; deduplicate
    const opsResueltasIds = new Set();
    const opsResueltas = [];
    [...opsResueltasAll].forEach(o => { if (!opsResueltasIds.has(o.id)) { opsResueltasIds.add(o.id); opsResueltas.push(o); } });

    // Objetivos
    function getObj(agId, grupoAgente) {
      const grp = (grupoAgente||"").toUpperCase();
      const match = d => {
        if (parseInt(d.semana||d.SEMANA) !== semana) return false;
        const a = parseInt(d.ano||d.AÑO||d.anio||0); if (a !== hoy.getFullYear()) return false;
        const ag = String(d.agente||d.COMERCIAL||"").toUpperCase();
        return ag === agId.toUpperCase() || ag === grp || (d.crmId && d.crmId === agId);
      };
      const pD = presupuesto.find(match), mD = monetizacion.find(match);
      const n = (d,...ks) => { if (!d) return 0; for (const k of ks) { const v = d[k]; if (v!==undefined&&v!==null&&v!=="") { const x = typeof v==="number"?v:parseFloat(String(v).replace(/[^0-9.\-]/g,"")); if (!isNaN(x)) return x; } } return 0; };
      // MB objetivo: primero presupuesto semanal, luego agentes_kpi
      let oMbRaw = n(pD,"mgPpto","MG PPTO","MG PPTO.","mgObjetivo","margenPpto");
      if (oMbRaw === 0) {
        // Fallback: agentes_kpi (objetivo anual de margen)
        const kpi = agentesKpi.find(k => {
          if (k.crmId && k.crmId === agId) return true;
          const ka = String(k.agente||k.nombre||"").toUpperCase();
          return ka === agId.toUpperCase() || ka === grp;
        });
        if (kpi) oMbRaw = n(kpi,"mgObjetivo","mgPpto","MG PPTO");
      }
      return {
        oV: n(pD,"ventasPpto","VENTAS PPTO.","VENTAS PPTO"),
        oMb: oMbRaw > 0 && oMbRaw < 1 ? +(oMbRaw*100).toFixed(1) : oMbRaw,
        oPromo: n(mD,"promoObjetivo","PROMO OBJETIVO"),
        oLiq: n(mD,"liquidObjetivo","LIQUID. OBJETIVO","LIQUID OBJETIVO"),
      };
    }

    // Hitos
    const hitosOk = [], hitosPend = [];
    const luStr = lu.toISOString().split("T")[0], viStr = vi.toISOString().split("T")[0];
    noElim(proyectos).filter(p => p.estado === "activo").forEach(p => {
      (p.hitos||[]).forEach(h => {
        if (typeof h !== "object" || !h) return;
        const f = h.fecha||"", fISO = f.includes("/") ? f.split("/").reverse().join("-") : f;
        if (h.hecho) {
          const fH = h.fechaHecho||h.fecha||"", fHISO = fH.includes("/") ? fH.split("/").reverse().join("-") : fH;
          if (fHISO >= luStr && fHISO <= viStr) hitosOk.push({ nombre:h.nombre||"Sin nombre", proyecto:p.nombre||"", responsable:h.responsable||"", fechaHecho:fH });
        } else if ((fISO >= luStr && fISO <= viStr) || (fISO && fISO < hoyStr)) {
          hitosPend.push({ nombre:h.nombre||"Sin nombre", proyecto:p.nombre||"", responsable:h.responsable||"", fecha:f, vencido:fISO<hoyStr });
        }
      });
    });

    // Muestras split
    const mNuevas = mueSem.filter(m => !m.fechaFeedback || m.estadoMuestra==="PENDIENTE DE ENVIAR" || m.estadoMuestra==="ENVIADO");
    const mResueltas = mueSem.filter(m => m.fechaFeedback && (m.estado==="pedido"||m.estado==="positivo"||m.estado==="ko"));

    // Estrategias split - FIX 2: count all, split new vs done
    const estNew = estSem.filter(e => !e.resultado || e.resultado === "");
    const estDone = estSem.filter(e => e.resultado && e.resultado !== "");

    // FIX 1: Visitas vs ruta — count clients in planned routes
    function calcVisRuta(agIds) {
      let total = 0;
      planes.filter(p => parseInt(p.semana) === semana && agIds.has(String(p.agente||"").toUpperCase()) && p.rutaNum).forEach(p => {
        const rNum = Number(p.rutaNum);
        const cliEnRuta = clientes.filter(c => {
          const r = Number(c.ruta||c.RUTA||c.numRuta||c.zona||0);
          return r === rNum;
        });
        total += cliEnRuta.length;
      });
      return total;
    }

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
      ["id","grupoAgente","nombre","username"].forEach(k => { if (ag[k]) ids.add(String(ag[k]).toUpperCase()); });
      return ids;
    }

    // ── Build context for a scope of agents ──
    function buildCtx(titulo, mgNombre, agentesScope, esJefe) {
      const allIds = new Set();
      agentesScope.forEach(u => idsAg(u).forEach(id => allIds.add(id)));
      const sf = arr => arr.filter(x => pertA(x, allIds));

      let tV=0,tP=0,tL=0,sMb=0,cMb=0,tOV=0,tOP=0,tOL=0,sOMb=0;

      const porVendedor = agentesScope.map(ag => {
        const ids = idsAg(ag);
        const inf = infSem.find(i => i.agente===ag.id||i.agenteId===ag.id);
        const obj = getObj(ag.id, ag.grupoAgente||"");
        const v = inf?(Number(inf.ventas)||Number(inf.venta)||0):0;
        const m = inf?(Number(inf.mb)||0):0;
        const p = inf?(Number(inf.promo)||0):0;
        const l = inf?(Number(inf.liq)||0):0;
        tV+=v; tP+=p; tL+=l; if(m>0){sMb+=m;cMb++;}
        tOV+=obj.oV; tOP+=obj.oPromo; tOL+=obj.oLiq; if(obj.oMb>0) sOMb+=obj.oMb;
        const visR = calcVisRuta(ids);
        return {
          nombre:ag.nombre||ag.id, equipo:ag.equipo||"SIN EQUIPO",
          v, mb:m, promo:p, liq:l, oV:obj.oV, oMb:obj.oMb, oPromo:obj.oPromo, oLiq:obj.oLiq,
          vis:sf(visSem).filter(x=>pertA(x,ids)).length, visR,
          ops:sf(opsSemana).filter(x=>pertA(x,ids)).length,
          est:sf(estSem).filter(x=>pertA(x,ids)).length,
          mue:sf(mueSem).filter(x=>pertA(x,ids)).length,
        };
      }).sort((a,b) => b.v-a.v || b.vis-a.vis);

      // FIX 3: Por equipo with objectives
      let porEquipo = null;
      if (!esJefe) {
        porEquipo = ["WIKUK","INTERKEY"].map(eq => {
          const idsEq = new Set();
          usuarios.filter(u=>(u.rol==="agente"||u.rol==="crm_agente")&&u.equipo===eq).forEach(u=>idsAg(u).forEach(id=>idsEq.add(id)));
          const agEq = agentesScope.filter(a => a.equipo === eq);
          let eqV=0,eqP=0,eqL=0,eqMb=0,eqCMb=0,eqOV=0,eqOP=0,eqOL=0,eqOMb=0;
          agEq.forEach(ag => {
            const inf = infSem.find(i=>i.agente===ag.id||i.agenteId===ag.id);
            const obj = getObj(ag.id,ag.grupoAgente||"");
            const v=inf?(Number(inf.ventas)||Number(inf.venta)||0):0;
            const m=inf?(Number(inf.mb)||0):0;
            eqV+=v; eqP+=inf?(Number(inf.promo)||0):0; eqL+=inf?(Number(inf.liq)||0):0;
            if(m>0){eqMb+=m;eqCMb++;}
            eqOV+=obj.oV; eqOP+=obj.oPromo; eqOL+=obj.oLiq; if(obj.oMb>0) eqOMb+=obj.oMb;
          });
          return {
            equipo: eq, v:eqV, mb:eqCMb>0?Math.round(eqMb/eqCMb*10)/10:0, promo:eqP, liq:eqL,
            oV:eqOV, oMb:eqCMb>0?Math.round(eqOMb/eqCMb*10)/10:0, oPromo:eqOP, oLiq:eqOL,
            vis:sf(visSem).filter(x=>pertA(x,idsEq)).length, visR:calcVisRuta(idsEq),
            ops:sf(opsSemana).filter(x=>pertA(x,idsEq)).length,
            est:sf(estSem).filter(x=>pertA(x,idsEq)).length,
            mue:sf(mueSem).filter(x=>pertA(x,idsEq)).length,
          };
        });
      }

      const totalVisR = calcVisRuta(allIds);

      return {
        titulo, nombre: mgNombre, semana, lu, vi, nombreMap,
        totales: {
          ventas:tV, oVentas:tOV, mb:cMb>0?Math.round(sMb/cMb*10)/10:0, oMb:cMb>0?Math.round(sOMb/cMb*10)/10:0,
          promo:tP, oPromo:tOP, liq:tL, oLiq:tOL,
          visitasReal:sf(visSem).length, visitasRuta:totalVisR,
          clientesNuevos:cliNuevos.filter(c=>pertA(c,allIds)||!esJefe).length,
          muestrasNuevas:mNuevas.filter(m=>pertA(m,allIds)||!esJefe).length,
          estrategias:sf(estSem).length,
          oportunidades:sf(opsSemana).length + opsResueltas.filter(o=>pertA(o,allIds)||!esJefe).length,
        },
        porEquipo, porVendedor,
        porDia: {
          visitas: groupByDay(sf(visSem), "fecha"),
          mNuevas: mNuevas.filter(m=>pertA(m,allIds)||!esJefe),
          mResueltas: mResueltas.filter(m=>pertA(m,allIds)||!esJefe),
          hitosOk: hitosOk.filter(h => allIds.has(String(h.responsable||"").toUpperCase()) || !esJefe),
          hitosPend: hitosPend.filter(h => allIds.has(String(h.responsable||"").toUpperCase()) || !esJefe),
          estNew: estNew.filter(e=>pertA(e,allIds)||!esJefe),
          estDone: estDone.filter(e=>pertA(e,allIds)||!esJefe),
          opsDone: opsResueltas.filter(o=>pertA(o,allIds)||!esJefe),
          opsNew: opsNuevasSem.filter(o=>pertA(o,allIds)||!esJefe),
        },
      };
    }

    // ── MANAGERS ──
    const managers = usuarios.filter(u=>["jefe","director","ceo"].includes(u.rol)&&u.email);
    for (const mg of managers) {
      const esJefe = mg.rol === "jefe";
      const scope = usuarios.filter(u=>(u.rol==="agente"||u.rol==="crm_agente")&&(esJefe?u.equipo===mg.equipo:true));
      const ctx = buildCtx(
        esJefe ? `Equipo ${mg.equipo} · Semana ${semana}` : `Informe consolidado · Semana ${semana}`,
        mg.nombre, scope, esJefe
      );
      const html = buildEmail(ctx);
      try {
        await transporter.sendMail({ from:process.env.SMTP_FROM||process.env.SMTP_USER, to:mg.email, subject:`📊 Informe semana ${semana}${esJefe?" · "+mg.equipo:""}`, html });
        sent.push({ tipo:mg.rol, nombre:mg.nombre, email:mg.email });
      } catch(err) { errors.push({ tipo:mg.rol, email:mg.email, error:err.message }); }
    }

    // ── AGENTES ──
    const agentes = usuarios.filter(u=>(u.rol==="agente"||u.rol==="crm_agente")&&u.email);
    for (const ag of agentes) {
      const ctx = buildCtx("Tu cierre de semana", ag.nombre, [ag], true);
      ctx.porVendedor = []; ctx.porEquipo = null;
      const html = buildEmail(ctx);
      try {
        await transporter.sendMail({ from:process.env.SMTP_FROM||process.env.SMTP_USER, to:ag.email, subject:`📊 Tu semana ${semana} · ${ag.nombre||ag.id}`, html });
        sent.push({ tipo:"agente", nombre:ag.nombre, email:ag.email });
      } catch(err) { errors.push({ tipo:"agente", email:ag.email, error:err.message }); }
    }

    return res.status(200).json({
      ok:true, semana, rango:{lunes:lu.toISOString(),viernes:vi.toISOString()},
      totales:{visitas:visSem.length,ops:opsSemana.length,est:estSem.length,mue:mueSem.length,informes:infSem.length,opsResueltas:opsResueltas.length,clientesNuevos:cliNuevos.length},
      sent, errors,
    });
  } catch(err) { return res.status(500).json({ ok:false, error:err.message, stack:err.stack }); }
}
