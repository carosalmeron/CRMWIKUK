// /api/compras-summary.js
// (v3.23.2) Endpoint Vercel - resumen semanal a Compras
// Frecuencia: lunes 7am (configurado en vercel.json)
// Email manual: GET/POST con ?manual=1 lo permite también

const nodemailer = require('nodemailer');

const FB_PROJECT = process.env.FB_PROJECT || 'grupo-consolidado-crm';
const FB_BASE = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

// ── Helpers Firestore ───────────────────────────────────
function deserializeValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue);
  if ('doubleValue' in v) return parseFloat(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(deserializeValue);
  if ('mapValue' in v) {
    const out = {};
    const fields = v.mapValue.fields || {};
    for (const k in fields) out[k] = deserializeValue(fields[k]);
    return out;
  }
  return null;
}

function deserializeDoc(doc) {
  if (!doc.fields) return {};
  const out = {};
  for (const k in doc.fields) out[k] = deserializeValue(doc.fields[k]);
  return out;
}

async function fetchCollection(name) {
  const docs = [];
  let pageToken = null;
  let safety = 50; // máx ~5000 docs
  do {
    const url = `${FB_BASE}/${name}?pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Firebase ${name} fetch failed:`, res.status);
      return docs;
    }
    const data = await res.json();
    (data.documents || []).forEach(d => docs.push(deserializeDoc(d)));
    pageToken = data.nextPageToken || null;
    safety--;
  } while (pageToken && safety > 0);
  return docs;
}

// ── Lógica del informe ──────────────────────────────────
function computeReport(ofertas, incidencias) {
  const hoy = new Date();
  const haceUnaSemana = new Date(hoy.getTime() - 7 * 24 * 60 * 60 * 1000);

  // OFERTAS marcadas como caras
  const caras = (ofertas || []).filter(o => {
    if (o.eliminada) return false;
    if (o.estado !== 'caro') return false;
    return true;
  });

  // Líneas con precio competencia
  const lineas = [];
  caras.forEach(o => {
    (o.lineas || []).forEach(l => {
      if (l.precioCompetencia == null) return;
      const precio = Number(l.precio) || 0;
      const comp = Number(l.precioCompetencia) || 0;
      lineas.push({
        ofertaId: o.id,
        cliente: o.clienteNombre || '',
        agente: o.agenteNombre || o.agente || '',
        equipo: o.equipo || '',
        fechaCierre: o.fechaCierre || o.fechaCreacion,
        producto: l.producto || '',
        calibre: l.calibre || '',
        unidad: l.unidad || '€/kg',
        precio: precio,
        precioCompetencia: comp,
        diferencia: precio - comp,
        diferenciaPct: comp > 0 ? ((precio - comp) / comp) * 100 : 0,
      });
    });
  });

  // Caros nuevos esta semana (cierre últimos 7 días)
  const carasNuevas = caras.filter(o => {
    const fc = o.fechaCierre || o.fechaCreacion;
    if (!fc) return false;
    const d = new Date(fc);
    return !isNaN(d.getTime()) && d >= haceUnaSemana;
  });

  // KPIs
  const totalCaras = caras.length;
  const totalLineas = lineas.length;
  const difMediaPct = lineas.length > 0
    ? lineas.reduce((a, l) => a + l.diferenciaPct, 0) / lineas.length
    : 0;
  const clientesUnicos = new Set(lineas.map(l => l.cliente));

  // Agrupar por artículo
  const agrArt = {};
  lineas.forEach(l => {
    const k = ((l.producto || '') + '|' + (l.calibre || '')).toUpperCase().trim();
    if (!agrArt[k]) agrArt[k] = { producto: l.producto, calibre: l.calibre, unidad: l.unidad, lineas: [], clientes: new Set() };
    agrArt[k].lineas.push(l);
    agrArt[k].clientes.add(l.cliente);
  });
  const listArt = Object.keys(agrArt).map(k => {
    const g = agrArt[k];
    const sumP = g.lineas.reduce((a, l) => a + l.precio, 0);
    const sumC = g.lineas.reduce((a, l) => a + l.precioCompetencia, 0);
    const prom = sumP / g.lineas.length;
    const comp = sumC / g.lineas.length;
    return {
      producto: g.producto,
      calibre: g.calibre,
      unidad: g.unidad,
      nLineas: g.lineas.length,
      nClientes: g.clientes.size,
      precioPromedio: prom,
      compPromedio: comp,
      diferenciaPct: comp > 0 ? ((prom - comp) / comp) * 100 : 0,
    };
  }).sort((a, b) => b.diferenciaPct - a.diferenciaPct);

  // INCIDENCIAS Stock + Calidad abiertas
  const incFiltradas = (incidencias || []).filter(i => {
    if (i.eliminada) return false;
    const t = (i.tipo || i.tipologia || '').toLowerCase();
    return t.indexOf('stock') >= 0 || t.indexOf('calidad') >= 0;
  });

  const incAbiertas = incFiltradas.filter(i => i.estado !== 'cerrada' && i.estado !== 'resuelta');
  const incStock = incAbiertas.filter(i => (i.tipo || i.tipologia || '').toLowerCase().indexOf('stock') >= 0);
  const incCalidad = incAbiertas.filter(i => (i.tipo || i.tipologia || '').toLowerCase().indexOf('calidad') >= 0);

  // Críticas: abiertas hace 5+ días
  const incCriticas = incAbiertas.filter(i => {
    const fc = i.fechaCreacion || i.fecha;
    if (!fc) return false;
    const d = new Date(fc);
    if (isNaN(d.getTime())) return false;
    const dias = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
    return dias >= 5;
  });

  return {
    ofertas: {
      total: totalCaras,
      nuevasSemana: carasNuevas.length,
      lineas: totalLineas,
      difMediaPct,
      clientesAfectados: clientesUnicos.size,
      topArticulos: listArt.slice(0, 5),
    },
    incidencias: {
      total: incAbiertas.length,
      stock: incStock.length,
      calidad: incCalidad.length,
      criticas: incCriticas.length,
      detalleStock: incStock.slice(0, 8),
      detalleCalidad: incCalidad.slice(0, 8),
    },
  };
}

// ── HTML del email ──────────────────────────────────────
function fmtNum(n) { return Number(n).toFixed(2).replace('.', ','); }
function fmtPct(n) { return (n >= 0 ? '+' : '') + Number(n).toFixed(1).replace('.', ',') + '%'; }

function buildEmailHtml(report, crmUrl) {
  const o = report.ofertas;
  const i = report.incidencias;
  const ahora = new Date();
  const fechaStr = ahora.toLocaleDateString('es-ES', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

  let html = `
  <!DOCTYPE html>
  <html><head><meta charset="utf-8"><style>
    body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1F2937;background:#F8FAFC;margin:0;padding:0;}
    .container{max-width:680px;margin:0 auto;background:#fff;}
    .header{background:linear-gradient(135deg,#0F172A 0%,#1E3A5F 100%);color:white;padding:24px;}
    .header h1{margin:0;font-size:22px;}
    .header p{margin:6px 0 0;opacity:.85;font-size:13px;}
    .section{padding:20px 24px;border-bottom:1px solid #E5E7EB;}
    .section h2{margin:0 0 14px;font-size:16px;color:#0F172A;border-left:4px solid #DC2626;padding-left:10px;}
    .section h2.green{border-color:#10B981;}
    .kpi-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin:0 0 8px;}
    .kpi{background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:12px;text-align:center;}
    .kpi.green{background:#ECFDF5;border-color:#A7F3D0;}
    .kpi.amber{background:#FFFBEB;border-color:#FDE68A;}
    .kpi-num{font-size:22px;font-weight:800;color:#DC2626;margin:0;}
    .kpi.green .kpi-num{color:#059669;}
    .kpi.amber .kpi-num{color:#B45309;}
    .kpi-lbl{font-size:11px;font-weight:600;color:#6B7280;margin:4px 0 0;text-transform:uppercase;}
    table{width:100%;border-collapse:collapse;margin-top:8px;font-size:12px;}
    th{background:#F1F5F9;padding:8px 10px;text-align:left;border-bottom:2px solid #94A3B8;font-weight:700;color:#1E293B;}
    td{padding:7px 10px;border-bottom:1px solid #E5E7EB;}
    .cara{color:#DC2626;font-weight:700;}
    .cta-box{text-align:center;padding:24px;background:#F8FAFC;}
    .cta{display:inline-block;background:#DC2626;color:white !important;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;}
    .footer{padding:16px 24px;background:#F1F5F9;color:#6B7280;font-size:11px;text-align:center;}
    .empty{text-align:center;padding:20px;color:#9CA3AF;font-style:italic;}
    .alert-row{padding:8px 12px;background:#FEF2F2;border-left:3px solid #DC2626;border-radius:6px;margin-bottom:6px;font-size:12px;}
  </style></head><body>
  <div class="container">

    <div class="header">
      <h1>📊 Resumen Compras</h1>
      <p>${fechaStr.charAt(0).toUpperCase() + fechaStr.slice(1)} · CRM Grupo Consolidado</p>
    </div>

    <div class="section">
      <h2>💸 Vamos caros</h2>
      <div class="kpi-grid">
        <div class="kpi"><p class="kpi-num">${o.total}</p><p class="kpi-lbl">Ofertas marcadas</p></div>
        <div class="kpi amber"><p class="kpi-num">${o.nuevasSemana}</p><p class="kpi-lbl">Nuevas esta semana</p></div>
        <div class="kpi"><p class="kpi-num">${fmtPct(o.difMediaPct)}</p><p class="kpi-lbl">vs Competencia</p></div>
        <div class="kpi"><p class="kpi-num">${o.clientesAfectados}</p><p class="kpi-lbl">Clientes afectados</p></div>
      </div>`;

  if (o.topArticulos.length > 0) {
    html += `<table>
      <thead><tr><th>Artículo</th><th>Tu precio</th><th>Competencia</th><th>Dif.</th><th>Casos</th></tr></thead>
      <tbody>`;
    o.topArticulos.forEach(a => {
      html += `<tr>
        <td><strong>${a.producto}</strong>${a.calibre ? ' · ' + a.calibre : ''}</td>
        <td>${fmtNum(a.precioPromedio)} ${a.unidad}</td>
        <td>${fmtNum(a.compPromedio)} ${a.unidad}</td>
        <td class="cara">${fmtPct(a.diferenciaPct)}</td>
        <td>${a.nLineas} (${a.nClientes} cli)</td>
      </tr>`;
    });
    html += `</tbody></table>`;
  } else {
    html += `<div class="empty">Sin ofertas marcadas como caras</div>`;
  }

  html += `</div>

    <div class="section">
      <h2 class="green">📦 Incidencias Stock + Calidad</h2>
      <div class="kpi-grid">
        <div class="kpi"><p class="kpi-num">${i.total}</p><p class="kpi-lbl">Total abiertas</p></div>
        <div class="kpi amber"><p class="kpi-num">${i.stock}</p><p class="kpi-lbl">📦 Stock</p></div>
        <div class="kpi amber"><p class="kpi-num">${i.calidad}</p><p class="kpi-lbl">⚠️ Calidad</p></div>
        <div class="kpi"><p class="kpi-num">${i.criticas}</p><p class="kpi-lbl">🚨 Críticas (5d+)</p></div>
      </div>`;

  if (i.detalleStock.length > 0) {
    html += `<p style="margin:14px 0 6px;font-size:13px;font-weight:700;color:#0F172A;">📦 Stock — primeras ${i.detalleStock.length}</p>`;
    i.detalleStock.forEach(inc => {
      const dias = inc.fechaCreacion ? Math.floor((Date.now() - new Date(inc.fechaCreacion).getTime()) / (1000 * 60 * 60 * 24)) : 0;
      html += `<div class="alert-row">
        <strong>${inc.cliente || inc.clienteNombre || '(Sin cliente)'}</strong>
        ${inc.titulo || inc.asunto || inc.descripcion || ''}
        <br><small style="color:#6B7280;">📅 ${inc.fechaCreacionStr || inc.fecha || ''} · ${dias}d abierta · ${inc.agenteNombre || inc.agente || ''}</small>
      </div>`;
    });
  }

  if (i.detalleCalidad.length > 0) {
    html += `<p style="margin:14px 0 6px;font-size:13px;font-weight:700;color:#0F172A;">⚠️ Calidad — primeras ${i.detalleCalidad.length}</p>`;
    i.detalleCalidad.forEach(inc => {
      const dias = inc.fechaCreacion ? Math.floor((Date.now() - new Date(inc.fechaCreacion).getTime()) / (1000 * 60 * 60 * 24)) : 0;
      html += `<div class="alert-row">
        <strong>${inc.cliente || inc.clienteNombre || '(Sin cliente)'}</strong>
        ${inc.titulo || inc.asunto || inc.descripcion || ''}
        <br><small style="color:#6B7280;">📅 ${inc.fechaCreacionStr || inc.fecha || ''} · ${dias}d abierta · ${inc.agenteNombre || inc.agente || ''}</small>
      </div>`;
    });
  }

  if (i.detalleStock.length === 0 && i.detalleCalidad.length === 0) {
    html += `<div class="empty">Sin incidencias abiertas de Stock ni Calidad</div>`;
  }

  html += `</div>

    <div class="cta-box">
      <a href="${crmUrl}" class="cta">🔗 Abrir CRM</a>
      <p style="margin:10px 0 0;font-size:11px;color:#6B7280;">Login: <strong>compras</strong></p>
    </div>

    <div class="footer">
      Email automático generado los miércoles y viernes a las 19:00 · CRM Grupo Consolidado
    </div>

  </div>
  </body></html>`;

  return html;
}

// ── Handler Vercel ──────────────────────────────────────
export default async function handler(req, res) {
  try {
    const ofertas = await fetchCollection('ofertas');
    const incidencias = await fetchCollection('incidencias');

    const report = computeReport(ofertas, incidencias);
    const crmUrl = process.env.CRM_URL || 'https://crmwikuk.vercel.app';
    const html = buildEmailHtml(report, crmUrl);

    const destinatario = (req.query && req.query.to) || process.env.EMAIL_COMPRAS;
    if (!destinatario) {
      return res.status(400).json({
        ok: false,
        error: 'No hay destinatario. Configura EMAIL_COMPRAS en Vercel o pasa ?to=email@…'
      });
    }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: (process.env.SMTP_SECURE || 'false') === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const subject = `📊 Resumen Compras — ${new Date().toLocaleDateString('es-ES')} · ${report.ofertas.nuevasSemana} caros / ${report.incidencias.total} incidencias`;

    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: destinatario,
      subject,
      html,
    });

    return res.status(200).json({
      ok: true,
      messageId: info.messageId,
      destinatario,
      kpis: {
        ofertasCaras: report.ofertas.total,
        ofertasNuevas: report.ofertas.nuevasSemana,
        incidenciasAbiertas: report.incidencias.total,
        incidenciasStock: report.incidencias.stock,
        incidenciasCalidad: report.incidencias.calidad,
      },
    });
  } catch (err) {
    console.error('Error en compras-summary:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
