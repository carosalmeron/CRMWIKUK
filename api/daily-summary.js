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

    // Resolver nombres de agentes - build comprehensive map
    const nombreMap = {};
    const equipoMap = {}; // agentId -> equipo
    portalUsers.forEach(u => {
      const nombre = u.nombre || '';
      if (!nombre) return;
      const keys = [u.username, u.id, u.perfilCRM, u.grupoAgente, u.catalogoVendedor, u._id];
      keys.forEach(k => { if (k) { nombreMap[k.toLowerCase()] = nombre; equipoMap[k.toLowerCase()] = (u.equipo||'').toUpperCase(); }});
      // Also map nombre lowercase to nombre (identity)
      nombreMap[nombre.toLowerCase()] = nombre;
      // Map equipoCrm members
      if (Array.isArray(u.equipoCrm)) {
        u.equipoCrm.forEach(m => { if (m) { nombreMap[m.toLowerCase()] = nombre; equipoMap[m.toLowerCase()] = (u.equipo||'').toUpperCase(); }});
      }
    });
    function resolverNombre(idOrName) {
      if (!idOrName) return 'Desconocido';
      const n = nombreMap[idOrName.toLowerCase()];
      if (n) return n;
      const found = portalUsers.find(u => (u.nombre || '').toLowerCase() === idOrName.toLowerCase());
      if (found) return found.nombre;
      return idOrName;
    }
    function resolverEquipo(idOrName) {
      if (!idOrName) return '';
      return equipoMap[idOrName.toLowerCase()] || '';
    }
    function resolverEstado(estado) {
      if (estado === 'en_curso') return 'aprobada';
      return estado || 'pendiente';
    }

    // ══════════════════════════════════════════════════════════
    // GENERAR HTML PERSONALIZADO POR DESTINATARIO
    // ══════════════════════════════════════════════════════════
    function buildEmail(titulo, subtitulo, misVisitas, misOfertas, misEstrategias, misIncidencias, misMuestras) {
      const tv = misVisitas.length, tof = misOfertas.length, test = misEstrategias.length, tinc = misIncidencias.length, tmue = misMuestras.length;
      const ofPed = misOfertas.filter(o => o.estado === 'pedido').length;
      const ofCar = misOfertas.filter(o => o.estado === 'caro').length;
      const vPorAg = {};
      misVisitas.forEach(v => { const ag = resolverNombre(v.agente||v.agenteId||v.agenteNombre); if (!vPorAg[ag]) vPorAg[ag]=[]; vPorAg[ag].push(v); });
      let htmlVis = '';
      Object.keys(vPorAg).sort((a,b) => vPorAg[b].length - vPorAg[a].length).forEach(ag => {
        const vs = vPorAg[ag];
        const ped = vs.filter(v => v.resultado === 'pedido').length;
        const lla = vs.filter(v => v.resultado === 'llamada').length;
        htmlVis += '<div style="margin-bottom:14px"><div style="background:#1E3A5F;color:#fff;padding:7px 14px;border-radius:8px;margin-bottom:6px;display:inline-block"><span style="font-size:13px;font-weight:800">🧑‍💼 '+esc(ag)+'</span><span style="font-size:11px;opacity:.7"> · '+vs.length+' vis'+(ped?' · '+ped+' ped.':'')+(lla?' · '+lla+' llam.':'')+'</span></div>';
        vs.forEach(v => {
          const rc = v.resultado==='pedido'?'#22C55E':v.resultado==='llamada'?'#3B82F6':v.resultado==='primera_visita'?'#8B5CF6':v.resultado==='no_contesta'?'#94A3B8':'#F59E0B';
          const rl = v.resultado==='pedido'?'Pedido':v.resultado==='llamada'?'Llamada':v.resultado==='primera_visita'?'Primera visita':v.resultado==='no_contesta'?'No contesta':v.resultado==='visita_sin_pedido'?'Visita s/pedido':(v.resultado||'Visita');
          const nota = v.notas||v.nota||'';
          htmlVis += '<div style="padding:7px 12px;margin-bottom:3px;border-left:3px solid '+rc+';background:#FAFAFA;border-radius:0 8px 8px 0"><strong style="font-size:13px;color:#0F172A">'+esc(v.clienteNombre||v.cliente||'?')+'</strong><p style="margin:1px 0 0;font-size:11px;color:'+rc+';font-weight:700">'+rl+'</p>'+(nota?'<p style="margin:3px 0 0;font-size:12px;color:#334155;line-height:1.4">'+esc(nota)+'</p>':'')+'</div>';
        });
        htmlVis += '</div>';
      });
      let htmlOf = misOfertas.map(o => { const ec=o.estado==='pedido'?'#22C55E':o.estado==='caro'?'#EF4444':'#F59E0B'; const el=o.estado==='pedido'?'✅ Pedido':o.estado==='caro'?'💸 Caros':'⏳ Pendiente'; const lin=(o.lineas||[]).map(l=>'📦 '+esc(l.producto||'')+(l.calibre?' · '+esc(l.calibre):'')+' → <strong>'+(l.precio?Number(l.precio).toFixed(2).replace('.',',')+' €/'+(l.unidad||'kg'):'')+'</strong>'+(l.precioCompetencia?' <span style="color:#EF4444">(comp: '+Number(l.precioCompetencia).toFixed(2).replace('.',',')+' €)</span>':'')).join('<br>'); return '<div style="padding:8px 12px;border-bottom:1px solid #F1F5F9"><div style="display:flex;justify-content:space-between;align-items:center"><strong style="font-size:12px">'+esc(o.clienteNombre||o.cliente||'')+'</strong> <span style="font-size:10px;font-weight:700;color:'+ec+';background:'+ec+'15;padding:2px 8px;border-radius:99px">'+el+'</span></div><p style="margin:2px 0 0;font-size:11px;color:#64748B">'+esc(resolverNombre(o.agente||o.agenteId))+'</p>'+(lin?'<div style="margin-top:3px;font-size:11px;color:#64748B">'+lin+'</div>':'')+'</div>'; }).join('');
      let htmlEst = misEstrategias.map(e => { const est=resolverEstado(e.estado); const ec=est==='aprobada'?'#22C55E':est==='rechazada'?'#EF4444':est==='pendiente_aprobacion'?'#F59E0B':'#7C3AED'; const el=est==='aprobada'?'✅ Aprobada':est==='rechazada'?'❌ Rechazada':est==='pendiente_aprobacion'?'⏳ Pend.':'📋 Pendiente'; const segs=e.seguimientos||[]; const ult=segs.length>0?segs[segs.length-1]:null; return '<div style="padding:8px 12px;border-bottom:1px solid #F1F5F9"><div style="display:flex;justify-content:space-between"><strong style="font-size:12px">'+esc(e.cliente||e.clienteNombre||'')+'</strong><span style="font-size:10px;font-weight:700;color:'+ec+';background:'+ec+'15;padding:2px 8px;border-radius:99px">'+el+'</span></div><p style="margin:2px 0 0;font-size:11px;color:#64748B">'+esc(resolverNombre(e.agente))+(e.maxDescuento?' · Dto: <strong>'+e.maxDescuento+'%</strong>':'')+'</p>'+(ult?'<div style="margin-top:3px;padding:3px 8px;background:#F8FAFC;border-radius:5px;border-left:2px solid '+ec+'"><span style="font-size:10px;font-weight:700">'+esc(ult.por||'')+'</span> <span style="font-size:9px;color:#94A3B8">'+esc(ult.fecha||'')+'</span>'+(ult.nota?'<p style="margin:1px 0 0;font-size:10px;color:#475569">'+esc(ult.nota.substring(0,100))+'</p>':'')+'</div>':'')+'</div>'; }).join('');
      let htmlInc = misIncidencias.map(i => { const cerr=i.estado==='cerrada'||i.estado==='resuelta'; const hist=i.historialEscalado||[]; const ult=hist.length>0?hist[hist.length-1]:null; return '<div style="padding:8px 12px;border-bottom:1px solid #F1F5F9;border-left:3px solid '+(cerr?'#22C55E':'#EF4444')+'"><strong style="font-size:12px;color:'+(cerr?'#22C55E':'#991B1B')+'">'+(cerr?'✅ ':'🔴 ')+esc((i.titulo||i.descripcion||i.tipo||'').substring(0,60))+'</strong><p style="margin:2px 0 0;font-size:11px;color:#64748B">'+esc(i.clienteNombre||'')+' · '+esc(resolverNombre(i.autor||i.agente))+'</p>'+(ult?'<div style="margin-top:3px;padding:3px 8px;background:'+(cerr?'#F0FDF4':'#FEF2F2')+';border-radius:5px"><span style="font-size:10px;font-weight:700">'+esc(ult.por||'')+'</span> <span style="font-size:9px;color:#94A3B8">'+esc(ult.fecha||'')+'</span>'+((ult.nota||ult.accion)?'<p style="margin:1px 0 0;font-size:10px;color:#475569">'+esc((ult.nota||ult.accion||'').substring(0,100))+'</p>':'')+'</div>':'')+'</div>'; }).join('');
      let htmlMue = misMuestras.map(m => '<div style="padding:5px 0;border-bottom:1px solid #F1F5F9"><strong>'+esc(m.producto||'')+'</strong> → '+esc(m.clienteNombre||m.cliente||'')+' · '+esc(resolverNombre(m.agente||m.agenteId))+' '+(m.estado==='aprobada'||m.feedback==='positivo'?'✅':m.estado==='rechazada'||m.feedback==='negativo'?'❌':'⏳')+'</div>').join('');
      return '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;background:#F8FAFC">'
        +'<div style="background:linear-gradient(135deg,#0F172A,#1E293B);padding:24px;border-radius:16px 16px 0 0;text-align:center">'
        +'<div style="background:rgba(255,255,255,.15);display:inline-block;padding:5px 14px;border-radius:99px;margin-bottom:8px"><span style="font-size:11px;font-weight:800;color:#fff;letter-spacing:.05em">📊 RESUMEN DEL DÍA ANTERIOR</span></div>'
        +'<h1 style="margin:0;font-size:18px;font-weight:800;color:#fff">'+esc(titulo)+'</h1>'
        +'<p style="margin:5px 0 0;font-size:12px;color:rgba(255,255,255,.6)">'+esc(subtitulo)+'</p></div>'
        +'<div style="background:#fff;padding:16px 24px;border-left:1px solid #E2E8F0;border-right:1px solid #E2E8F0"><div style="display:flex;gap:8px;text-align:center;flex-wrap:wrap">'
        +'<div style="flex:1;min-width:55px;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:10px;padding:10px 6px"><div style="font-size:22px;font-weight:900;color:#22C55E">'+tv+'</div><div style="font-size:9px;font-weight:700;color:#15803D">VISITAS</div></div>'
        +'<div style="flex:1;min-width:55px;background:#FFFBEB;border:1px solid #FDE68A;border-radius:10px;padding:10px 6px"><div style="font-size:22px;font-weight:900;color:#F59E0B">'+tof+'</div><div style="font-size:9px;font-weight:700;color:#92400E">OFERTAS</div></div>'
        +'<div style="flex:1;min-width:55px;background:#F5F3FF;border:1px solid #DDD6FE;border-radius:10px;padding:10px 6px"><div style="font-size:22px;font-weight:900;color:#7C3AED">'+test+'</div><div style="font-size:9px;font-weight:700;color:#7C3AED">ESTRAT.</div></div>'
        +'<div style="flex:1;min-width:55px;background:#FEF2F2;border:1px solid #FECACA;border-radius:10px;padding:10px 6px"><div style="font-size:22px;font-weight:900;color:#EF4444">'+tinc+'</div><div style="font-size:9px;font-weight:700;color:#991B1B">INCID.</div></div>'
        +'<div style="flex:1;min-width:55px;background:#EFF6FF;border:1px solid #BFDBFE;border-radius:10px;padding:10px 6px"><div style="font-size:22px;font-weight:900;color:#3B82F6">'+tmue+'</div><div style="font-size:9px;font-weight:700;color:#1E40AF">MUESTRAS</div></div>'
        +'</div></div>'
        // Team summary
        +(function(){
          var teams={WIKUK:{vis:0,ofe:0,est:0,inc:0,mue:0,ped:0,ags:{}},INTERKEY:{vis:0,ofe:0,est:0,inc:0,mue:0,ped:0,ags:{}}};
          misVisitas.forEach(function(v){var eq=resolverEquipo(v.agente||v.agenteId)||(v.equipo||'').toUpperCase();var t=teams[eq];if(t){t.vis++;var ag=resolverNombre(v.agente||v.agenteId);t.ags[ag]=(t.ags[ag]||0)+1;if(v.resultado==='pedido')t.ped++;}});
          misOfertas.forEach(function(o){var eq=resolverEquipo(o.agente||o.agenteId)||(o.equipo||'').toUpperCase();var t=teams[eq];if(t)t.ofe++;});
          misEstrategias.forEach(function(e){var eq=resolverEquipo(e.agente)||(e.equipo||'').toUpperCase();var t=teams[eq];if(t)t.est++;});
          misIncidencias.forEach(function(i){var eq=resolverEquipo(i.autor||i.agente);var t=teams[eq];if(t)t.inc++;});
          misMuestras.forEach(function(m){var eq=resolverEquipo(m.agente||m.agenteId)||(m.equipo||'').toUpperCase();var t=teams[eq];if(t)t.mue++;});
          var anyData=(teams.WIKUK.vis+teams.INTERKEY.vis)>0||(teams.WIKUK.ofe+teams.INTERKEY.ofe)>0;
          if(!anyData) return '';
          var html='<div style="background:#fff;padding:14px 24px;border-left:1px solid #E2E8F0;border-right:1px solid #E2E8F0">'
            +'<p style="margin:0 0 10px;font-size:13px;font-weight:800;color:#0F172A">👥 Resumen por equipo</p>'
            +'<div style="display:flex;gap:10px">';
          [{k:'WIKUK',color:'#1E5A8A',bg:'#EBF2F8',icon:'🔵'},{k:'INTERKEY',color:'#2E6B42',bg:'#EDF4F0',icon:'🟢'}].forEach(function(eq){
            var t=teams[eq.k];var nAg=Object.keys(t.ags).length;
            html+='<div style="flex:1;background:'+eq.bg+';border:1.5px solid '+eq.color+'30;border-radius:12px;padding:12px;text-align:center">'
              +'<div style="font-size:14px;font-weight:900;color:'+eq.color+'">'+eq.icon+' '+eq.k+'</div>'
              +'<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px;justify-content:center">'
              +'<span style="background:#fff;border:1px solid '+eq.color+'30;border-radius:6px;padding:2px 8px;font-size:11px"><strong style="color:'+eq.color+'">'+t.vis+'</strong> vis</span>'
              +'<span style="background:#fff;border:1px solid '+eq.color+'30;border-radius:6px;padding:2px 8px;font-size:11px"><strong style="color:#22C55E">'+t.ped+'</strong> ped</span>'
              +'<span style="background:#fff;border:1px solid '+eq.color+'30;border-radius:6px;padding:2px 8px;font-size:11px"><strong>'+t.ofe+'</strong> ofe</span>'
              +'<span style="background:#fff;border:1px solid '+eq.color+'30;border-radius:6px;padding:2px 8px;font-size:11px"><strong>'+t.mue+'</strong> mue</span>'
              +'</div>'
              +'<p style="margin:6px 0 0;font-size:10px;color:'+eq.color+'">'+nAg+' vendedores activos</p>'
              +'</div>';
          });
          html+='</div></div>';
          return html;
        })()
        +(tv>0?'<div style="background:#fff;padding:14px 24px;border-left:1px solid #E2E8F0;border-right:1px solid #E2E8F0"><p style="margin:0 0 10px;font-size:13px;font-weight:800;color:#0F172A">📋 Visitas</p>'+htmlVis+'</div>':'')
        +(tof>0?'<div style="background:#fff;padding:14px 24px;border-left:1px solid #E2E8F0;border-right:1px solid #E2E8F0"><p style="margin:0 0 8px;font-size:13px;font-weight:800;color:#0F172A">💰 Ofertas ('+ofPed+' ped. · '+ofCar+' caros)</p><div style="background:#FAFAFA;border-radius:8px;overflow:hidden">'+htmlOf+'</div></div>':'')
        +(test>0?'<div style="background:#fff;padding:14px 24px;border-left:1px solid #E2E8F0;border-right:1px solid #E2E8F0"><p style="margin:0 0 8px;font-size:13px;font-weight:800;color:#0F172A">🎯 Estrategias</p><div style="background:#FAFAFA;border-radius:8px;overflow:hidden">'+htmlEst+'</div></div>':'')
        +(tinc>0?'<div style="background:#fff;padding:14px 24px;border-left:1px solid #E2E8F0;border-right:1px solid #E2E8F0"><p style="margin:0 0 8px;font-size:13px;font-weight:800;color:#0F172A">🚨 Incidencias</p><div style="background:#FAFAFA;border-radius:8px;overflow:hidden">'+htmlInc+'</div></div>':'')
        +(tmue>0?'<div style="background:#fff;padding:14px 24px;border-left:1px solid #E2E8F0;border-right:1px solid #E2E8F0"><p style="margin:0 0 8px;font-size:13px;font-weight:800;color:#0F172A">📦 Muestras</p><div style="background:#FAFAFA;border-radius:8px;overflow:hidden;padding:8px 12px;font-size:12px;color:#64748B">'+htmlMue+'</div></div>':'')
        +'<div style="background:#F1F5F9;padding:16px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 16px 16px;text-align:center"><a href="https://crmwikuk.vercel.app" style="display:inline-block;background:#0F172A;color:#fff;padding:10px 24px;border-radius:10px;text-decoration:none;font-weight:700;font-size:12px">🔗 Abrir CRM</a></div></div>';
    }

    // ══════════════════════════════════════════════════════════
    // ENVIAR EMAILS PERSONALIZADOS
    // ══════════════════════════════════════════════════════════
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    let enviados = 0;
    const destinatarios = portalUsers.filter(u => u.email);

    function esDelUsuario(agId, user) {
      if (!agId || !user) return false;
      const a = agId.toLowerCase();
      return a===(user.username||'').toLowerCase()||a===(user.id||'').toLowerCase()||a===(user.grupoAgente||'').toLowerCase()||a===(user.perfilCRM||'').toLowerCase()||a===(user.catalogoVendedor||'').toLowerCase();
    }
    function esDelEquipo(item, equipo) {
      if (!equipo) return true;
      if ((item.equipo||'').toUpperCase()===equipo) return true;
      const agId=(item.agente||item.agenteId||item.autor||'').toLowerCase();
      const agUser=portalUsers.find(u=>(u.username||'').toLowerCase()===agId||(u.id||'').toLowerCase()===agId||(u.grupoAgente||'').toLowerCase()===agId);
      return agUser&&(agUser.equipo||'').toUpperCase()===equipo;
    }

    for (const dest of destinatarios) {
      const rol=(dest.rol||'').toLowerCase(); const perfil=(dest.perfilCRM||'').toLowerCase();
      const esCeo=rol==='ceo'||perfil==='ceo';
      const esDir=rol==='crm_director'||rol==='director'||perfil==='crm_director';
      const esJefe=rol==='crm_jefe';
      const esAgente=rol==='crm_agente'||rol==='agente'||rol==='comercial';
      const esTipo=perfil&&perfil.startsWith('resp_');
      if(esTipo&&!esJefe&&!esCeo&&!esDir) continue;
      if(!esCeo&&!esDir&&!esJefe&&!esAgente) continue;
      let titulo,subtitulo,fVis,fOf,fEst,fInc,fMue;
      const eq=(dest.equipo||'').toUpperCase();
      if(esCeo||esDir){
        titulo=diaSemanaAyer+' '+ayerStr+' — Global';
        subtitulo='Semana '+semana+' · WIKUK + INTERKEY · CRM Grupo Consolidado';
        fVis=visitasAyer;fOf=ofertasRecientes;fEst=estrategiasRecientes;fInc=incidenciasRecientes;fMue=muestrasRecientes;
      } else if(esJefe){
        titulo=diaSemanaAyer+' '+ayerStr+' — '+(eq||'Equipo');
        subtitulo='Semana '+semana+' · Equipo '+(eq||'?')+' · CRM Grupo Consolidado';
        fVis=visitasAyer.filter(v=>esDelEquipo(v,eq));fOf=ofertasRecientes.filter(o=>esDelEquipo(o,eq));fEst=estrategiasRecientes.filter(e=>esDelEquipo(e,eq));fInc=incidenciasRecientes.filter(i=>esDelEquipo(i,eq));fMue=muestrasRecientes.filter(m=>esDelEquipo(m,eq));
      } else {
        titulo=diaSemanaAyer+' '+ayerStr+' — Tu resumen';
        subtitulo='Semana '+semana+' · '+(dest.nombre||dest.username)+' · CRM Grupo Consolidado';
        fVis=visitasAyer.filter(v=>esDelUsuario(v.agente||v.agenteId,dest));fOf=ofertasRecientes.filter(o=>esDelUsuario(o.agente||o.agenteId,dest));fEst=estrategiasRecientes.filter(e=>esDelUsuario(e.agente,dest)||esDelUsuario(e.creadoPor,dest));fInc=incidenciasRecientes.filter(i=>esDelUsuario(i.autor,dest)||esDelUsuario(i.agente,dest));fMue=muestrasRecientes.filter(m=>esDelUsuario(m.agente||m.agenteId,dest));
      }
      if(fVis.length+fOf.length+fEst.length+fInc.length+fMue.length===0) continue;
      const html=buildEmail(titulo,subtitulo,fVis,fOf,fEst,fInc,fMue);
      const asunto='📊 Resumen '+diaSemanaAyer+' '+ayerStr+' — '+fVis.length+' vis · '+fOf.length+' ofe · '+fMue.length+' mue · '+fEst.length+' est · '+fInc.length+' inc';
      try{
        await transporter.sendMail({from:'"CRM Grupo Consolidado" <'+process.env.SMTP_USER+'>',to:dest.email,subject:'[CRM] '+asunto,html});
        console.log('[DAILY] ✅ '+(dest.nombre||dest.username)+' ('+rol+') → '+dest.email);
        enviados++;
      }catch(e){console.error('[DAILY] ❌ '+dest.email+':',e.message);}
    }
    console.log('[DAILY] Done: '+enviados+' emails');
    return res.status(200).json({ok:true,enviados,total:destinatarios.length});
  }catch(err){
    console.error('[DAILY] Error:',err);
    return res.status(500).json({error:err.message});
  }
};
