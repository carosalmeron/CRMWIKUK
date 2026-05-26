// (v3.26.6) Endpoint Vercel - resumen semanal a Compras + Resp.Stock + CEO
// Frecuencia: lunes y jueves 8:00 CET (configurado en vercel.json)
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
  const out = { _id: (doc.name || '').split('/').pop() };
  for (const k in doc.fields) out[k] = deserializeValue(doc.fields[k]);
  return out;
}

async function fetchCollection(name) {
  const docs = [];
  let pageToken = null;
  let safety = 50;
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
function computeReport(ofertas, incidencias, usuarios) {
  const hoy = new Date();
  const haceUnaSemana = new Date(hoy.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Mapa de usuarios para resolver agentes
  const allUsers = usuarios || [];
  function findUser(agId) {
    if (!agId) return null;
    const up = (agId || '').toUpperCase();
    return allUsers.find(u =>
      u.id === agId || u._id === agId ||
      (u.catalogoVendedor || '').toUpperCase() === up ||
      (u.grupoAgente || '').toUpperCase() === up ||
      (u.nombre || '').toUpperCase() === up
    );
  }

  // OFERTAS marcadas como caras
  const caras = (ofertas || []).filter(o => !o.eliminada && o.estado === 'caro');

  // Líneas con precio competencia
  const lineas = [];
  caras.forEach(o => {
    const usr = findUser(o.agente || o.agenteId);
    const equipo = (usr && usr.equipo) ? usr.equipo : (o.equipo || 'Sin equipo');
    const agNombre = usr ? (usr.nombre || o.agente) : (o.agenteNombre || o.agente || '');

    (o.lineas || []).forEach(l => {
      const precio = Number(l.precio) || 0;
      const comp = Number(l.precioCompetencia) || 0;
      lineas.push({
        ofertaId: o.id,
        cliente: o.clienteNombre || '',
        agente: agNombre,
        equipo: equipo,
        fechaCierre: o.fechaCierre || o.fechaCreacion,
        fechaStr: o.fechaCreacionStr || '',
        producto: l.producto || '',
        calibre: l.calibre || '',
        unidad: l.unidad || '€/kg',
        precio, precioCompetencia: comp,
        diferencia: precio - comp,
        diferenciaPct: comp > 0 ? ((precio - comp) / comp) * 100 : 0,
      });
    });

    // Si no tiene líneas, incluir la oferta como una entrada
    if (!o.lineas || o.lineas.length === 0) {
      lineas.push({
        ofertaId: o.id,
        cliente: o.clienteNombre || '',
        agente: agNombre,
        equipo: equipo,
        fechaCierre: o.fechaCierre || o.fechaCreacion,
        fechaStr: o.fechaCreacionStr || '',
        producto: '(Sin producto)',
        calibre: '', unidad: '€/kg',
        precio: 0, precioCompetencia: 0,
        diferencia: 0, diferenciaPct: 0,
      });
    }
  });

  // Caros nuevos esta semana
  const carasNuevas = caras.filter(o => {
    const fc = o.fechaCierre || o.fechaCreacion;
    if (!fc) return false;
    const d = new Date(fc);
    return !isNaN(d.getTime()) && d >= haceUnaSemana;
  });

  // KPIs
  const totalCaras = caras.length;
  const lineasConPrecio = lineas.filter(l => l.precioCompetencia > 0);
  const difMediaPct = lineasConPrecio.length > 0
    ? lineasConPrecio.reduce((a, l) => a + l.diferenciaPct, 0) / lineasConPrecio.length
    : 0;
  const clientesUnicos = new Set(lineas.map(l => l.cliente));

  // ── Agrupar por EQUIPO y luego por PRODUCTO ──
  const porEquipo = {};
  lineas.forEach(l => {
    if (!porEquipo[l.equipo]) porEquipo[l.equipo] = { equipo: l.equipo, lineas: [], clientes: new Set() };
    porEquipo[l.equipo].lineas.push(l);
    porEquipo[l.equipo].clientes.add(l.cliente);
  });

  const equipos = Object.values(porEquipo).map(g => {
    // Sub-agrupar por producto
    const porProd = {};
    g.lineas.forEach(l => {
      const k = ((l.producto || '') + '|' + (l.calibre || '')).toUpperCase().trim();
      if (!porProd[k]) porProd[k] = { producto: l.producto, calibre: l.calibre, unidad: l.unidad, lineas: [], clientes: new Set() };
      porProd[k].lineas.push(l);
      porProd[k].clientes.add(l.cliente);
    });

    const productos = Object.values(porProd).map(p => {
      const sumP = p.lineas.reduce((a, l) => a + l.precio, 0);
      const sumC = p.lineas.reduce((a, l) => a + l.precioCompetencia, 0);
      const prom = sumP / p.lineas.length;
      const comp = sumC / p.lineas.length;
      return {
        producto: p.producto, calibre: p.calibre, unidad: p.unidad,
        nLineas: p.lineas.length, nClientes: p.clientes.size,
        precioPromedio: prom, compPromedio: comp,
        diferenciaPct: comp > 0 ? ((prom - comp) / comp) * 100 : 0,
        detalle: p.lineas,
      };
    }).sort((a, b) => b.nLineas - a.nLineas);

    return { equipo: g.equipo, total: g.lineas.length, clientes: g.clientes.size, productos };
  }).sort((a, b) => b.total - a.total);

  // Artículos global (top 5)
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
      producto: g.producto, calibre: g.calibre, unidad: g.unidad,
      nLineas: g.lineas.length, nClientes: g.clientes.size,
      precioPromedio: prom, compPromedio: comp,
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
  const incCriticas = incAbiertas.filter(i => {
    const fc = i.fechaCreacion || i.fecha;
    if (!fc) return false;
    const d = new Date(fc);
    if (isNaN(d.getTime())) return false;
    return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24)) >= 5;
  });

  return {
    ofertas: {
      total: totalCaras, nuevasSemana: carasNuevas.length,
      lineas: lineas.length, difMediaPct,
      clientesAfectados: clientesUnicos.size,
      topArticulos: listArt.slice(0, 5),
      equipos,
    },
    incidencias: {
      total: incAbiertas.length, stock: incStock.length,
      calidad: incCalidad.length, criticas: incCriticas.length,
      detalleStock: incStock.slice(0, 8),
      detalleCalidad: incCalidad.slice(0, 8),
    },
  };
}

// ── HTML del email ──────────────────────────────────────
function fmtNum(n) { return Number(n).toFixed(2).replace('.', ','); }
function fmtPct(n) { return (n >= 0 ? '+' : '') + Number(n).toFixed(1).replace('.', ',') + '%'; }
function esc(s) { return (s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function buildEmailHtml(report, crmUrl, equipoFilter) {
  const o = report.ofertas;
  const ahora = new Date();
  const fechaStr = ahora.toLocaleDateString('es-ES', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  const tituloEquipo = equipoFilter ? ` — ${equipoFilter}` : '';

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
    .eq-header{padding:12px 16px;color:#fff;font-weight:800;font-size:14px;border-radius:10px 10px 0 0;margin-top:16px;}
    .eq-body{background:#fff;padding:14px 16px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 10px 10px;margin-bottom:4px;}
    .prod-title{margin:0 0 6px;font-size:13px;font-weight:800;color:#0F172A;}
    .cta-box{text-align:center;padding:24px;background:#F8FAFC;}
    .cta{display:inline-block;background:#DC2626;color:white !important;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;}
    .footer{padding:16px 24px;background:#F1F5F9;color:#6B7280;font-size:11px;text-align:center;}
    .empty{text-align:center;padding:20px;color:#9CA3AF;font-style:italic;}
    .alert-row{padding:8px 12px;background:#FEF2F2;border-left:3px solid #DC2626;border-radius:6px;margin-bottom:6px;font-size:12px;}
  </style></head><body>
  <div class="container">

    <div class="header">
      <h1>📊 Resumen Compras${tituloEquipo}</h1>
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

  // ── Top artículos global ──
  if (o.topArticulos.length > 0) {
    html += `<p style="margin:14px 0 6px;font-size:13px;font-weight:700;color:#0F172A;">🏆 Top artículos más caros vs competencia</p>
      <table>
      <thead><tr><th>Artículo</th><th>Tu precio</th><th>Competencia</th><th>Dif.</th><th>Casos</th></tr></thead>
      <tbody>`;
    o.topArticulos.forEach(a => {
      html += `<tr>
        <td><strong>${esc(a.producto)}</strong>${a.calibre ? ' · ' + esc(a.calibre) : ''}</td>
        <td>${fmtNum(a.precioPromedio)} ${esc(a.unidad)}</td>
        <td>${a.compPromedio > 0 ? fmtNum(a.compPromedio) + ' ' + esc(a.unidad) : '—'}</td>
        <td class="cara">${a.compPromedio > 0 ? fmtPct(a.diferenciaPct) : '—'}</td>
        <td>${a.nLineas} (${a.nClientes} cli)</td>
      </tr>`;
    });
    html += `</tbody></table>`;
  }

  // ── Desglose por EQUIPO ──
  if (o.equipos && o.equipos.length > 0) {
    html += `<p style="margin:20px 0 4px;font-size:13px;font-weight:700;color:#0F172A;">📋 Desglose por equipo</p>`;
    o.equipos.forEach(eq => {
      const eqColor = eq.equipo === 'WIKUK' ? '#22C55E' : eq.equipo === 'INTERKEY' ? '#F59E0B' : '#94A3B8';
      html += `<div class="eq-header" style="background:${eqColor}">${esc(eq.equipo)} — ${eq.total} línea${eq.total !== 1 ? 's' : ''} · ${eq.clientes} cliente${eq.clientes !== 1 ? 's' : ''}</div>
      <div class="eq-body">`;
      eq.productos.forEach(p => {
        html += `<p class="prod-title">📦 ${esc(p.producto)}${p.calibre ? ' · ' + esc(p.calibre) : ''} <span style="color:#94A3B8;font-weight:600">(${p.nLineas})</span></p>`;
        html += `<table><thead><tr><th>Cliente</th><th>Agente</th><th>Fecha</th><th>Precio</th></tr></thead><tbody>`;
        p.detalle.forEach(d => {
          html += `<tr>
            <td>${esc(d.cliente)}</td>
            <td>${esc(d.agente)}</td>
            <td>${esc(d.fechaStr)}</td>
            <td style="font-weight:700;color:#DC2626">${d.precio > 0 ? fmtNum(d.precio) + ' ' + esc(d.unidad) : '—'}</td>
          </tr>`;
        });
        html += `</tbody></table>`;
      });
      html += `</div>`;
    });
  } else {
    html += `<div class="empty">Sin ofertas marcadas como caras</div>`;
  }

  html += `</div>

    <div class="cta-box">
      <a href="${crmUrl}" class="cta">🔗 Abrir CRM</a>
    </div>

    <div class="footer">
      Email automático · Lunes y Jueves 8:00 · CRM Grupo Consolidado
    </div>

  </div>
  </body></html>`;

  return html;
}

// ── Handler Vercel ──────────────────────────────────────
export default async function handler(req, res) {
  try {
    const [ofertas, incidencias, usuarios, portalUsers] = await Promise.all([
      fetchCollection('ofertas'),
      fetchCollection('incidencias'),
      fetchCollection('usuarios'),
      fetchCollection('portal_users'),
    ]);

    // Merge usuarios + portal_users
    const allUsers = [...(usuarios || [])];
    (portalUsers || []).forEach(pu => {
      if (!pu.nombre) return;
      const yaExiste = allUsers.some(u =>
        (u.id || u._id) === (pu.id || pu._id || pu.username) ||
        (u.nombre || '').toUpperCase() === (pu.nombre || '').toUpperCase()
      );
      if (!yaExiste) allUsers.push(pu);
    });

    const report = computeReport(ofertas, incidencias, allUsers);
    const crmUrl = process.env.CRM_URL || 'https://crmwikuk.vercel.app';
    const html = buildEmailHtml(report, crmUrl);

    // ── Destinatarios: Compras + Resp.Stock + CEO + Director + Jefes ──
    const destinatarios = [];
    const emailsVistos = new Set();

    // Email de compras (variable de entorno)
    const emailCompras = (req.query && req.query.to) || process.env.EMAIL_COMPRAS;
    if (emailCompras) {
      destinatarios.push({ email: emailCompras, nombre: 'Compras', rol: 'compras', equipo: '' });
      emailsVistos.add(emailCompras);
    }

    // Resp. Stock — búsqueda precisa por ID primero
    var stockUser = allUsers.find(u => u.email && (u.id||u._id||'') === 'resp_stk');
    if (!stockUser) stockUser = allUsers.find(u => u.email && (u.tipologia||'').toLowerCase() === 'stock' && (u.rol||'').toLowerCase() === 'tipologia');
    if (stockUser && !emailsVistos.has(stockUser.email)) {
      destinatarios.push({ email: stockUser.email, nombre: stockUser.nombre || 'Resp. Stock', rol: 'tipologia', equipo: '' });
      emailsVistos.add(stockUser.email);
    }

    // CEO, Director y Jefes desde Firebase
    allUsers.forEach(u => {
      if (!u.email || emailsVistos.has(u.email)) return;
      const id = (u.id || u._id || '').toLowerCase();
      const rol = (u.rol || '').toLowerCase();
      const isCeo = id === 'ceo' || rol === 'ceo';
      const isDirector = id === 'dir' || rol === 'director' || rol === 'crm_director';
      const isJefe = rol === 'jefe' || rol === 'crm_jefe';
      if (isCeo || isDirector || isJefe) {
        destinatarios.push({ email: u.email, nombre: u.nombre || id, rol, equipo: u.equipo || '' });
        emailsVistos.add(u.email);
      }
    });

    if (destinatarios.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'Sin destinatarios. Configura EMAIL_COMPRAS o verifica emails en Firebase.'
      });
    }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: (process.env.SMTP_SECURE || 'false') === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    // (v3.26.6) Envío personalizado: jefes ven solo su equipo
    const resultados = [];
    for (const dest of destinatarios) {
      // Buscar usuario de este email
      const destUser = allUsers.find(u => u.email === dest.email);
      const rolDest = (destUser && destUser.rol || '').toLowerCase();
      const equipoDest = destUser && destUser.equipo || '';
      const esJefe = rolDest === 'jefe' || rolDest === 'crm_jefe';

      // Filtrar report para jefes — solo su equipo
      let reportPersonal = report;
      if (esJefe && equipoDest) {
        const equiposFiltrados = report.ofertas.equipos.filter(e => e.equipo === equipoDest);
        const lineasEquipo = equiposFiltrados.reduce((a, e) => a + e.total, 0);
        const clientesEquipo = new Set();
        equiposFiltrados.forEach(e => e.productos.forEach(p => p.detalle.forEach(d => clientesEquipo.add(d.cliente))));
        reportPersonal = {
          ofertas: {
            ...report.ofertas,
            total: lineasEquipo,
            clientesAfectados: clientesEquipo.size,
            equipos: equiposFiltrados,
            topArticulos: [],  // no aplica en vista individual
          }
        };
      }

      const html = buildEmailHtml(reportPersonal, crmUrl, esJefe ? equipoDest : null);
      const subject = esJefe
        ? `📊 Vamos Caros ${equipoDest} — ${new Date().toLocaleDateString('es-ES')}`
        : `📊 Resumen Compras — ${new Date().toLocaleDateString('es-ES')} · ${report.ofertas.nuevasSemana} caros nuevos`;

      try {
        const info = await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: dest.email,
          subject,
          html,
        });
        resultados.push({ email: dest.email, nombre: dest.nombre, rol: dest.rol, ok: true, messageId: info.messageId });
      } catch (e) {
        resultados.push({ email: dest.email, nombre: dest.nombre, ok: false, error: e.message });
      }
    }

    return res.status(200).json({
      ok: true,
      destinatarios: resultados,
      kpis: {
        ofertasCaras: report.ofertas.total,
        ofertasNuevas: report.ofertas.nuevasSemana,
        equipos: report.ofertas.equipos.map(e => `${e.equipo}:${e.total}`),
        incidenciasAbiertas: report.incidencias.total,
      },
    });
  } catch (err) {
    console.error('Error en compras-summary:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
