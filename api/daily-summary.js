// (v3.30.6) Daily Summary - Resumen diario de actividad
// Cron: lunes a viernes 8:00 CET (6:00 UTC)
// Manual: GET/POST ?manual=1

const nodemailer = require('nodemailer');

const FB_PROJECT = process.env.FB_PROJECT || 'grupo-consolidado-crm';
const FB_BASE = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

function deserializeValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue);
  if ('doubleValue' in v) return parseFloat(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(deserializeValue);
  if ('mapValue' in v) {
    const out = {};
    for (const k in (v.mapValue.fields || {})) out[k] = deserializeValue(v.mapValue.fields[k]);
    return out;
  }
  return null;
}

function deserializeDoc(doc) {
  if (!doc.fields) return {};
  const out = { id: (doc.name || '').split('/').pop() };
  for (const k in doc.fields) out[k] = deserializeValue(doc.fields[k]);
  return out;
}

async function fetchCollection(name) {
  const docs = [];
  let pageToken = null;
  let safety = 50;
  do {
    const url = `${FB_BASE}/${name}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) return docs;
    const data = await res.json();
    (data.documents || []).forEach(d => docs.push(deserializeDoc(d)));
    pageToken = data.nextPageToken || null;
    safety--;
  } while (pageToken && safety > 0);
  return docs;
}

function esAyer(fechaStr) {
  if (!fechaStr) return false;
  const ayer = new Date(Date.now() - 86400000);
  const ayerD = ayer.getDate(), ayerM = ayer.getMonth() + 1, ayerY = ayer.getFullYear();
  
  // Parse the input date
  let d, m, y;
  if (fechaStr.includes('T')) {
    // ISO format
    const dt = new Date(fechaStr);
    if (isNaN(dt.getTime())) return false;
    d = dt.getDate(); m = dt.getMonth() + 1; y = dt.getFullYear();
  } else if (fechaStr.includes('/')) {
    // dd/mm/yy or dd/mm/yyyy
    const parts = fechaStr.split('/');
    if (parts.length < 3) return false;
    d = parseInt(parts[0]); m = parseInt(parts[1]); y = parseInt(parts[2]);
    if (y < 100) y += 2000;
  } else {
    return false;
  }
  
  return d === ayerD && m === ayerM && y === ayerY;
}

function esc(s) { return (s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

module.exports = async function handler(req, res) {
  console.log('[DAILY] Starting daily summary...');

  try {
    // Cargar datos
    const [usuarios, portalUsers, visitas, ofertas, muestras, estrategias, incidencias, tareas] = await Promise.all([
      fetchCollection('portal_users'),
      fetchCollection('portal_users'),
      fetchCollection('visitas'),
      fetchCollection('ofertas'),
      fetchCollection('muestras'),
      fetchCollection('estrategias'),
      fetchCollection('incidencias'),
      fetchCollection('tareas'),
    ]);

    // Semana actual
    const hoy = new Date();
    const ayer = new Date(Date.now() - 86400000);
    const ayerStr = ayer.getDate() + '/' + (ayer.getMonth() + 1) + '/' + ayer.getFullYear();
    const start = new Date(hoy.getFullYear(), 0, 1);
    const semana = Math.ceil(((hoy - start) / 86400000 + start.getDay() + 1) / 7);
    const diaSemanaAyer = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'][ayer.getDay()];

    // Filtrar actividad reciente (ayer = último día laborable)
    const visitasAyer = visitas.filter(v => !v.eliminada && (esAyer(v.fecha) || esAyer(v.fechaCreacion) || esAyer(v.fechaCreacionStr)));
    const ofertasRecientes = ofertas.filter(o => !o.eliminada && (esAyer(o.fechaCreacionStr) || esAyer(o.fechaCreacion) || esAyer(o.fechaCierre)));
    const muestrasRecientes = muestras.filter(m => !m.eliminada && (esAyer(m.fecha) || esAyer(m.fechaCreacion) || esAyer(m.fechaCreacionStr)));
    const estrategiasRecientes = estrategias.filter(e => {
      if (e.eliminada) return false;
      if (esAyer(e.fechaCreacionStr)) return true;
      const segs = e.seguimientos || [];
      return segs.some(s => esAyer(s.fecha));
    });
    const incidenciasRecientes = incidencias.filter(i => {
      if (i.eliminada) return false;
      if (esAyer(i.fecha) || esAyer(i.fechaCreacion)) return true;
      const hist = i.historialEscalado || [];
      return hist.some(h => esAyer(h.fecha));
    });
    const tareasRecientes = tareas.filter(t => !t.eliminada && (esAyer(t.fechaCreacion) || esAyer(t.vencimiento)));

    // Resolver nombres de agentes
    const nombreMap = {};
    portalUsers.forEach(u => {
      const id = (u.username || u.id || '').toLowerCase();
      const nombre = u.nombre || u.username || u.id || '';
      if (id) nombreMap[id] = nombre;
      // Also map perfilCRM
      if (u.perfilCRM) nombreMap[u.perfilCRM.toLowerCase()] = nombre;
      // grupoAgente
      if (u.grupoAgente) nombreMap[u.grupoAgente.toLowerCase()] = nombre;
    });
    function resolverNombre(idOrName) {
      if (!idOrName) return 'Desconocido';
      const n = nombreMap[(idOrName || '').toLowerCase()];
      return n || idOrName;
    }
    function resolverEstado(estado) {
      if (estado === 'en_curso') return 'aprobada';
      return estado || 'pendiente';
    }

    // Agrupar visitas por agente (nombre resuelto)
    const visitasPorAgente = {};
    visitasAyer.forEach(v => {
      const ag = resolverNombre(v.agente || v.agenteId || v.agenteNombre);
      if (!visitasPorAgente[ag]) visitasPorAgente[ag] = [];
      visitasPorAgente[ag].push(v);
    });

    // Estadísticas de ofertas
    const ofPedidos = ofertasRecientes.filter(o => o.estado === 'pedido').length;
    const ofCaros = ofertasRecientes.filter(o => o.estado === 'caro').length;
    const ofPendientes = ofertasRecientes.filter(o => !o.estado || o.estado === 'pendiente').length;

    // Construir email
    const totalVisitas = visitasAyer.length;
    const agentes = Object.keys(visitasPorAgente);

    let htmlVisitas = '';
    agentes.sort((a, b) => visitasPorAgente[b].length - visitasPorAgente[a].length).forEach(ag => {
      const vs = visitasPorAgente[ag];
      const pedidos = vs.filter(v => v.resultado === 'pedido').length;
      const llamadas = vs.filter(v => v.resultado === 'llamada').length;
      const sinPedido = vs.filter(v => v.resultado === 'visita_sin_pedido').length;
      const primera = vs.filter(v => v.resultado === 'primera_visita').length;
      // Resultados summary
      let resTxt = [];
      if (pedidos) resTxt.push(`<strong style="color:#22C55E">${pedidos} ped.</strong>`);
      if (llamadas) resTxt.push(`${llamadas} llam.`);
      if (sinPedido) resTxt.push(`${sinPedido} s/ped.`);
      if (primera) resTxt.push(`${primera} 1ª vis.`);

      htmlVisitas += `<tr>
        <td style="padding:10px 12px;border-bottom:1px solid #F1F5F9;vertical-align:top">
          <strong style="font-size:13px;color:#0F172A">${esc(ag)}</strong>
          <div style="margin-top:4px;font-size:10px;color:#94A3B8;line-height:1.6">
            ${vs.slice(0, 6).map(v => {
              const resIcon = v.resultado === 'pedido' ? '✅' : v.resultado === 'llamada' ? '📞' : v.resultado === 'primera_visita' ? '🆕' : v.resultado === 'no_contesta' ? '🔇' : '👋';
              return `${resIcon} ${esc(v.clienteNombre || v.cliente || '?')}${v.notas || v.nota ? ' — <em>' + esc((v.notas || v.nota || '').substring(0, 50)) + '</em>' : ''}`;
            }).join('<br>')}
            ${vs.length > 6 ? `<br><span style="color:#64748B">+${vs.length - 6} más</span>` : ''}
          </div>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #F1F5F9;text-align:center;font-weight:800;font-size:16px;color:#22C55E;vertical-align:top">${vs.length}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #F1F5F9;text-align:center;font-size:11px;vertical-align:top">${resTxt.length > 0 ? resTxt.join(' · ') : '-'}</td>
      </tr>`;
    });

    let htmlOfertas = '';
    ofertasRecientes.slice(0, 8).forEach(o => {
      const estColor = o.estado === 'pedido' ? '#22C55E' : o.estado === 'caro' ? '#EF4444' : '#F59E0B';
      const estLabel = o.estado === 'pedido' ? '✅ Pedido' : o.estado === 'caro' ? '💸 Caros' : '⏳ Pendiente';
      const lineas = o.lineas || [];
      htmlOfertas += `<div style="padding:10px 12px;border-bottom:1px solid #F1F5F9">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div><strong style="font-size:12px">${esc(o.clienteNombre || o.cliente || '')}</strong>
          <span style="font-size:11px;color:#64748B"> · ${esc(resolverNombre(o.agente || o.agenteId))}</span></div>
          <span style="font-size:10px;font-weight:700;color:${estColor};background:${estColor}15;padding:2px 8px;border-radius:99px">${estLabel}</span>
        </div>
        ${lineas.length > 0 ? `<div style="margin-top:4px;font-size:11px;color:#64748B">${lineas.map(l => 
          `📦 ${esc(l.producto || '')}${l.calibre ? ' · ' + esc(l.calibre) : ''} → <strong style="color:#0F172A">${l.precio ? Number(l.precio).toFixed(2).replace('.', ',') + '€/' + (l.unidad || 'kg') : ''}</strong>${l.precioCompetencia ? ' <span style="color:#EF4444">(comp: ' + Number(l.precioCompetencia).toFixed(2).replace('.', ',') + '€)</span>' : ''}`
        ).join('<br>')}</div>` : ''}
        ${o.notaCaro ? `<p style="margin:3px 0 0;font-size:10px;color:#991B1B;font-style:italic">"${esc(o.notaCaro.substring(0, 80))}"</p>` : ''}
      </div>`;
    });

    let htmlEstrategias = '';
    estrategiasRecientes.slice(0, 6).forEach(e => {
      const segs = e.seguimientos || [];
      const ult = segs.length > 0 ? segs[segs.length - 1] : null;
      const estado = resolverEstado(e.estado);
      const estColor = estado === 'aprobada' ? '#22C55E' : estado === 'rechazada' ? '#EF4444' : estado === 'pendiente_aprobacion' ? '#F59E0B' : '#7C3AED';
      const estLabel = estado === 'aprobada' ? '✅ Aprobada' : estado === 'rechazada' ? '❌ Rechazada' : estado === 'pendiente_aprobacion' ? '⏳ Pend. aprob.' : '📋 Pendiente';
      htmlEstrategias += `<div style="padding:10px 12px;border-bottom:1px solid #F1F5F9">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong style="font-size:12px">${esc(e.cliente || e.clienteNombre || '')}</strong>
          <span style="font-size:10px;font-weight:700;color:${estColor};background:${estColor}15;padding:2px 8px;border-radius:99px">${estLabel}</span>
        </div>
        <p style="margin:2px 0 0;font-size:11px;color:#64748B">${esc(resolverNombre(e.agente))}${e.maxDescuento ? ' · Dto: <strong>' + e.maxDescuento + '%</strong>' : ''}</p>
        <p style="margin:2px 0 0;font-size:11px;color:#475569">${esc((e.texto || e.estrategia || e.descripcion || '').substring(0, 100))}</p>
        ${ult ? `<div style="margin-top:4px;padding:4px 8px;background:#F8FAFC;border-radius:6px;border-left:2px solid ${estColor}">
          <span style="font-size:10px;font-weight:700;color:#0F172A">${esc(ult.por || '')}</span>
          <span style="font-size:9px;color:#94A3B8"> · ${esc(ult.fecha || '')}</span>
          ${ult.nota ? `<p style="margin:2px 0 0;font-size:10px;color:#475569">${esc(ult.nota.substring(0, 100))}</p>` : ''}
        </div>` : ''}
      </div>`;
    });

    let htmlIncidencias = '';
    incidenciasRecientes.slice(0, 6).forEach(i => {
      const esCerrada = i.estado === 'cerrada' || i.estado === 'resuelta';
      const hist = i.historialEscalado || [];
      const ult = hist.length > 0 ? hist[hist.length - 1] : null;
      htmlIncidencias += `<div style="padding:10px 12px;border-bottom:1px solid #F1F5F9;border-left:3px solid ${esCerrada ? '#22C55E' : '#EF4444'}">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong style="font-size:12px;color:${esCerrada ? '#22C55E' : '#991B1B'}">${esCerrada ? '✅ ' : '🔴 '}${esc((i.titulo || i.descripcion || i.tipo || '').substring(0, 60))}</strong>
        </div>
        <p style="margin:2px 0 0;font-size:11px;color:#64748B">${esc(i.clienteNombre || '')} · ${esc(resolverNombre(i.autor || i.agente))} · ${esc(i.tipo || '')}</p>
        ${ult ? `<div style="margin-top:4px;padding:4px 8px;background:${esCerrada ? '#F0FDF4' : '#FEF2F2'};border-radius:6px">
          <span style="font-size:10px;font-weight:700;color:${esCerrada ? '#166534' : '#1E40AF'}">${esc(ult.por || '')}</span>
          <span style="font-size:9px;color:#94A3B8"> · ${esc(ult.fecha || '')}</span>
          ${ult.nota || ult.accion ? `<p style="margin:2px 0 0;font-size:10px;color:#475569">${esc((ult.nota || ult.accion || '').substring(0, 100))}</p>` : ''}
        </div>` : ''}
      </div>`;
    });

    const emailHtml = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;background:#F8FAFC">
      <div style="background:linear-gradient(135deg,#0F172A,#1E293B);padding:28px 24px;border-radius:16px 16px 0 0;text-align:center">
        <div style="background:rgba(255,255,255,.15);display:inline-block;padding:6px 16px;border-radius:99px;margin-bottom:10px">
          <span style="font-size:11px;font-weight:800;color:#fff;letter-spacing:.05em">📊 RESUMEN DEL DÍA ANTERIOR</span>
        </div>
        <h1 style="margin:0;font-size:20px;font-weight:800;color:#fff">${diaSemanaAyer} ${ayerStr}</h1>
        <p style="margin:6px 0 0;font-size:12px;color:rgba(255,255,255,.6)">Semana ${semana} · CRM Grupo Consolidado</p>
      </div>

      <!-- KPIs -->
      <div style="background:#fff;padding:20px 24px;border-left:1px solid #E2E8F0;border-right:1px solid #E2E8F0">
        <div style="display:flex;gap:10px;text-align:center">
          <div style="flex:1;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:12px;padding:14px 8px">
            <div style="font-size:28px;font-weight:900;color:#22C55E">${totalVisitas}</div>
            <div style="font-size:10px;font-weight:700;color:#15803D;text-transform:uppercase">Visitas</div>
          </div>
          <div style="flex:1;background:#FFFBEB;border:1px solid #FDE68A;border-radius:12px;padding:14px 8px">
            <div style="font-size:28px;font-weight:900;color:#F59E0B">${ofertasRecientes.length}</div>
            <div style="font-size:10px;font-weight:700;color:#92400E;text-transform:uppercase">Ofertas</div>
          </div>
          <div style="flex:1;background:#F5F3FF;border:1px solid #DDD6FE;border-radius:12px;padding:14px 8px">
            <div style="font-size:28px;font-weight:900;color:#7C3AED">${estrategiasRecientes.length}</div>
            <div style="font-size:10px;font-weight:700;color:#7C3AED;text-transform:uppercase">Estrategias</div>
          </div>
          <div style="flex:1;background:#FEF2F2;border:1px solid #FECACA;border-radius:12px;padding:14px 8px">
            <div style="font-size:28px;font-weight:900;color:#EF4444">${incidenciasRecientes.length}</div>
            <div style="font-size:10px;font-weight:700;color:#991B1B;text-transform:uppercase">Incidencias</div>
          </div>
        </div>
      </div>

      <!-- Visitas por agente -->
      ${totalVisitas > 0 ? `
      <div style="background:#fff;padding:0 24px 16px;border-left:1px solid #E2E8F0;border-right:1px solid #E2E8F0">
        <p style="margin:0 0 8px;font-size:11px;font-weight:800;color:#94A3B8;text-transform:uppercase;letter-spacing:.05em">👥 Visitas por vendedor</p>
        <table style="width:100%;border-collapse:collapse;background:#FAFAFA;border-radius:10px;overflow:hidden">
          <tr style="background:#F1F5F9"><th style="padding:6px 12px;text-align:left;font-size:10px;color:#64748B">Vendedor</th><th style="padding:6px 12px;text-align:center;font-size:10px;color:#64748B">Visitas</th><th style="padding:6px 12px;text-align:center;font-size:10px;color:#64748B">Resultado</th></tr>
          ${htmlVisitas}
        </table>
      </div>` : ''}

      <!-- Ofertas -->
      ${ofertasRecientes.length > 0 ? `
      <div style="background:#fff;padding:0 24px 16px;border-left:1px solid #E2E8F0;border-right:1px solid #E2E8F0">
        <p style="margin:0 0 8px;font-size:11px;font-weight:800;color:#94A3B8;text-transform:uppercase;letter-spacing:.05em">💰 Ofertas (${ofPedidos} pedidos · ${ofCaros} caros · ${ofPendientes} pend.)</p>
        <div style="background:#FAFAFA;border-radius:10px;overflow:hidden">${htmlOfertas}</div>
      </div>` : ''}

      <!-- Estrategias -->
      ${estrategiasRecientes.length > 0 ? `
      <div style="background:#fff;padding:0 24px 16px;border-left:1px solid #E2E8F0;border-right:1px solid #E2E8F0">
        <p style="margin:0 0 8px;font-size:11px;font-weight:800;color:#94A3B8;text-transform:uppercase;letter-spacing:.05em">🎯 Estrategias con actividad</p>
        <div style="background:#FAFAFA;border-radius:10px;overflow:hidden">${htmlEstrategias}</div>
      </div>` : ''}

      <!-- Incidencias -->
      ${incidenciasRecientes.length > 0 ? `
      <div style="background:#fff;padding:0 24px 16px;border-left:1px solid #E2E8F0;border-right:1px solid #E2E8F0">
        <p style="margin:0 0 8px;font-size:11px;font-weight:800;color:#94A3B8;text-transform:uppercase;letter-spacing:.05em">🚨 Incidencias con actividad</p>
        <div style="background:#FAFAFA;border-radius:10px;overflow:hidden">${htmlIncidencias}</div>
      </div>` : ''}

      <!-- Muestras -->
      ${muestrasRecientes.length > 0 ? `
      <div style="background:#fff;padding:0 24px 16px;border-left:1px solid #E2E8F0;border-right:1px solid #E2E8F0">
        <p style="margin:0 0 8px;font-size:11px;font-weight:800;color:#94A3B8;text-transform:uppercase;letter-spacing:.05em">📦 Muestras (${muestrasRecientes.length})</p>
        <div style="background:#FAFAFA;border-radius:10px;overflow:hidden;padding:8px 12px;font-size:12px;color:#64748B">
          ${muestrasRecientes.slice(0, 6).map(m => `<div style="padding:6px 0;border-bottom:1px solid #F1F5F9"><strong>${esc(m.producto || '')}</strong> → ${esc(m.clienteNombre || m.cliente || '')} · ${esc(resolverNombre(m.agente || m.agenteId))} <span style="color:${m.estado === 'aprobada' || m.feedback === 'positivo' ? '#22C55E' : m.estado === 'rechazada' || m.feedback === 'negativo' ? '#EF4444' : '#F59E0B'};font-weight:700">${m.estado === 'aprobada' || m.feedback === 'positivo' ? '✅' : m.estado === 'rechazada' || m.feedback === 'negativo' ? '❌' : '⏳'}</span></div>`).join('')}
        </div>
      </div>` : ''}

      <!-- Footer -->
      <div style="background:#F1F5F9;padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 16px 16px;text-align:center">
        <a href="https://crmwikuk.vercel.app" style="display:inline-block;background:#0F172A;color:#fff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:13px">🔗 Abrir CRM</a>
        <p style="margin:10px 0 0;font-size:10px;color:#94A3B8">CRM Grupo Consolidado · Resumen diario automático</p>
      </div>
    </div>`;

    // Destinatarios: CEO + Director + Jefes
    const destinatarios = portalUsers.filter(u => {
      if (!u.email) return false;
      const rol = (u.rol || '').toLowerCase();
      const perfil = (u.perfilCRM || '').toLowerCase();
      return rol === 'ceo' || rol === 'crm_director' || rol === 'director' ||
             rol === 'crm_jefe' || perfil === 'ceo' || perfil === 'crm_director';
    });

    if (destinatarios.length === 0) {
      console.log('[DAILY] No hay destinatarios con email');
      return res.status(200).json({ ok: true, msg: 'Sin destinatarios' });
    }

    // Enviar
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    const asunto = `📊 Resumen del día anterior — ${diaSemanaAyer} ${ayerStr} — ${totalVisitas} visitas · ${ofertasRecientes.length} ofertas · ${estrategiasRecientes.length} estrategias`;
    let enviados = 0;

    for (const dest of destinatarios) {
      try {
        await transporter.sendMail({
          from: `"CRM Grupo Consolidado" <${process.env.SMTP_USER}>`,
          to: dest.email,
          subject: `[CRM] ${asunto}`,
          html: emailHtml
        });
        console.log(`[DAILY] ✅ → ${dest.email}`);
        enviados++;
      } catch (e) {
        console.error(`[DAILY] ❌ ${dest.email}:`, e.message);
      }
    }

    console.log(`[DAILY] Done: ${enviados}/${destinatarios.length} emails`);
    return res.status(200).json({
      ok: true,
      enviados,
      destinatarios: destinatarios.length,
      stats: { visitas: totalVisitas, ofertas: ofertasRecientes.length, estrategias: estrategiasRecientes.length, incidencias: incidenciasRecientes.length, muestras: muestrasRecientes.length }
    });
  } catch (err) {
    console.error('[DAILY] Error:', err);
    return res.status(500).json({ error: err.message });
  }
};
