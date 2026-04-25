// Vercel Cron — Resumen diario por rol (Comercial/Jefe/Director/Calidad/I+D/Logistica/Produccion)
// Lunes-Viernes 7:00 AM España (5:00 UTC)
const nodemailer = require(‘nodemailer’);
const https = require(‘https’);

const FB_BASE = ‘https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents’;

function httpGet(url) {
return new Promise(function(resolve, reject) {
https.get(url, function(res) {
var data = ‘’;
res.on(‘data’, function(c) { data += c; });
res.on(‘end’, function() { try { resolve(JSON.parse(data)); } catch(e) { resolve({}); } });
}).on(‘error’, reject);
});
}

function pv(v) {
if (!v) return undefined;
if (v.stringValue !== undefined) return v.stringValue;
if (v.integerValue !== undefined) return parseInt(v.integerValue);
if (v.doubleValue !== undefined) return parseFloat(v.doubleValue);
if (v.booleanValue !== undefined) return v.booleanValue;
if (v.nullValue !== undefined) return null;
if (v.arrayValue) return (v.arrayValue.values || []).map(pv);
if (v.mapValue) { var o={}; Object.entries(v.mapValue.fields||{}).forEach(function(e){o[e[0]]=pv(e[1]);}); return o; }
return undefined;
}

function fb(col) {
return httpGet(FB_BASE + ‘/’ + col + ‘?pageSize=500’).then(function(d) {
if (!d.documents) return [];
return d.documents.map(function(doc) {
var obj = { id: doc.name.split(’/’).pop() };
Object.entries(doc.fields || {}).forEach(function(e) { var val = pv(e[1]); if (val !== undefined) obj[e[0]] = val; });
return obj;
});
}).catch(function() { return []; });
}

var fmt = function(n) { return new Intl.NumberFormat(‘es-ES’).format(n); };

function hdr(bg, title, sub) {
return ‘<div style="background:'+bg+';color:#fff;padding:20px 24px;border-radius:14px 14px 0 0"><h2 style="margin:0 0 4px;font-size:18px">’+title+’</h2><p style="margin:0;font-size:13px;opacity:.7">’+sub+’</p></div>’;
}

function blk(bg, border, title, items) {
if (items.length === 0) return ‘’;
return ‘<div style="margin-bottom:16px;padding:12px 16px;background:'+bg+';border-radius:10px;border-left:4px solid '+border+'"><p style="margin:0 0 6px;font-size:13px;font-weight:700;color:'+border+'">’+title+’</p>’+items.map(function(t){return ‘<p style="margin:2px 0;font-size:12px;color:#475569">· ‘+t+’</p>’;}).join(’’)+’</div>’;
}

function kpi(val, label, color) {
return ‘<td style="background:'+color+'15;border-radius:10px;padding:12px;text-align:center"><p style="margin:0;font-size:20px;font-weight:800;color:'+color+'">’+val+’</p><p style="margin:2px 0 0;font-size:10px;color:#64748B">’+label+’</p></td>’;
}

module.exports = async function handler(req, res) {
if (!process.env.SMTP_USER) return res.status(503).json({error:‘SMTP not configured’});

var transporter = nodemailer.createTransport({
host: process.env.SMTP_HOST || ‘smtp.gmail.com’,
port: parseInt(process.env.SMTP_PORT || ‘587’),
secure: false,
auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
tls: { rejectUnauthorized: false },
});

var hoy = new Date();
var hoyStr = hoy.toLocaleDateString(‘es-ES’,{weekday:‘long’,day:‘numeric’,month:‘long’,year:‘numeric’});
var sem = Math.ceil(((hoy-new Date(hoy.getFullYear(),0,1))/86400000+new Date(hoy.getFullYear(),0,1).getDay()+1)/7);

try {
console.log(’[SUMMARY] Loading data…’);
var results = await Promise.all([
fb(‘portal_users’), fb(‘tareas’), fb(‘incidencias’),
fb(‘estrategias’), fb(‘oportunidades’), fb(‘muestras’), fb(‘proyectos’)
]);
var portal=results[0], tareas=results[1], inc=results[2], est=results[3], ops=results[4], muestras=results[5], proyectos=results[6];
console.log(’[SUMMARY] Data: portal=’+portal.length+’ tareas=’+tareas.length+’ inc=’+inc.length+’ ops=’+ops.length+’ muestras=’+muestras.length);

```
var users = {};
portal.forEach(function(pu) {
  if (!pu.email) return;
  users[pu.id] = { email:pu.email, nombre:pu.nombre||pu.id, vendor:(pu.catalogoVendedor||'').toUpperCase(), rol:pu.rol||'crm_agente', equipo:pu.equipo };
});
console.log('[SUMMARY] Users with email: '+Object.keys(users).length);

var sent = 0;
var footer = '<a href="https://crmwikuk.vercel.app" style="display:inline-block;padding:14px 28px;background:#1E3A5F;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px;margin-top:12px">Abrir CRM</a><p style="margin:20px 0 0;font-size:10px;color:#94A3B8;text-align:center">CRM Grupo Consolidado</p>';

for (var uid in users) {
  var u = users[uid];
  var r = u.rol;
  var subject = '', body = '';

  // ═══════════════════════════════════════
  // COMERCIAL
  // ═══════════════════════════════════════
  if (r==='crm_agente'||r==='agente') {
    var v=u.vendor; if(!v) continue;
    var myT=tareas.filter(function(t){return !t.eliminada&&t.estado!=='hecha'&&((t.agente||'').toUpperCase()===v||(t.agenteId||'').toUpperCase()===v);});
    var myI=inc.filter(function(i){return !i.eliminada&&i.estado!=='cerrada'&&i.estado!=='resuelta'&&((i.agente||'').toUpperCase()===v||(i.autor||'').toUpperCase()===v);});
    var myE=est.filter(function(e){return !e.eliminada&&e.estado==='en_curso'&&!e.resolucion&&(e.agente||'').toUpperCase()===v;});
    var myO=ops.filter(function(o){return !o.eliminada&&!['ganada','perdida','cerrada_ganada','cerrada_perdida'].includes(o.estado||o.etapa)&&((o.agente||'').toUpperCase()===v||(o.agenteId||'').toUpperCase()===v);});
    var myM=muestras.filter(function(m){return !m.eliminada&&m.estado==='pendiente'&&(m.agente||'').toUpperCase()===v;});
    var pipe=myO.reduce(function(s,o){return s+(parseInt(o.valor)||0);},0);
    if(myT.length+myI.length+myE.length+myO.length+myM.length===0) continue;
    subject='CRM '+hoyStr+': '+myT.length+' tareas, '+myI.length+' inc, '+myO.length+' ops';
    body=hdr('#1E3A5F','Buenos dias, '+u.nombre,hoyStr+' - Semana '+sem)
      +'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'
      +'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(myT.length,'Tareas','#F59E0B')+kpi(myO.length,'Ops','#3B82F6')+kpi(fmt(pipe)+'E','Pipeline','#1E3A5F')+'</tr></table>'
      +blk('#FEF3C7','#F59E0B','Tareas pendientes ('+myT.length+')',myT.slice(0,4).map(function(t){return (t.titulo||t.texto||'')+(t.vence?' - '+t.vence:'');}))
      +blk('#FEE2E2','#EF4444','Incidencias ('+myI.length+')',myI.slice(0,3).map(function(i){return (i.titulo||i.tipo||'')+(i.clienteNombre?' - '+i.clienteNombre:'');}))
      +blk('#DBEAFE','#3B82F6','Estrategias ('+myE.length+')',myE.slice(0,3).map(function(e){return (e.cliente||'')+' - '+(e.texto||e.objetivo||'').substring(0,60);}))
      +blk('#F5F3FF','#7C3AED','Muestras pendientes ('+myM.length+')',myM.slice(0,3).map(function(m){return (m.prod||'')+' - '+(m.cliente||'');}))
      +footer+'</div>';
  }

  // ═══════════════════════════════════════
  // DIRECTOR / CEO
  // ═══════════════════════════════════════
  else if (r==='crm_director'||r==='director'||r==='ceo') {
    var opsAct=ops.filter(function(o){return !o.eliminada&&!['ganada','perdida','cerrada_ganada','cerrada_perdida'].includes(o.estado||o.etapa);});
    var incAbi=inc.filter(function(i){return !i.eliminada&&i.estado!=='cerrada'&&i.estado!=='resuelta';});
    var estAct=est.filter(function(e){return !e.eliminada&&e.estado==='en_curso'&&!e.resolucion;});
    var mPend=muestras.filter(function(m){return !m.eliminada&&m.estado==='pendiente';});
    var pipe2=opsAct.reduce(function(s,o){return s+(parseInt(o.valor)||0);},0);
    var pryAct=proyectos.filter(function(p){return p.estado==='activo'&&!p.eliminada;});
    var opsGan=ops.filter(function(o){return !o.eliminada&&(o.estado==='ganada'||o.etapa==='cerrada_ganada');});
    subject='Panel ejecutivo: '+fmt(pipe2)+'E pipeline, '+incAbi.length+' inc, '+estAct.length+' estrategias';
    body=hdr('#1E3A5F','Panel ejecutivo',hoyStr+' - Semana '+sem)
      +'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'
      +'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(opsAct.length,'Ops activas','#3B82F6')+kpi(incAbi.length,'Incidencias','#EF4444')+kpi(fmt(pipe2)+'E','Pipeline','#1E3A5F')+kpi(estAct.length,'Estrategias','#7C3AED')+'</tr></table>'
      +blk('#FEE2E2','#EF4444','Incidencias abiertas ('+incAbi.length+')',incAbi.slice(0,4).map(function(i){return (i.tipo||'')+': '+(i.titulo||i.asunto||'')+(i.clienteNombre?' - '+i.clienteNombre:'');}))
      +blk('#DBEAFE','#3B82F6','Estrategias activas ('+estAct.length+')',estAct.slice(0,4).map(function(e){return (e.cliente||'')+' - '+(e.texto||'').substring(0,50);}))
      +blk('#F5F3FF','#7C3AED','Muestras sin respuesta ('+mPend.length+')',mPend.slice(0,3).map(function(m){return (m.prod||'')+' - '+(m.cliente||'');}))
      +(pryAct.length>0?blk('#F8FAFC','#64748B','Proyectos activos ('+pryAct.length+')',pryAct.slice(0,3).map(function(p){return (p.nombre||'')+' - '+(p.progreso||0)+'%';})):'')
      +(opsGan.length>0?blk('#F0FDF4','#22C55E','Ops ganadas ('+opsGan.length+')',opsGan.slice(0,3).map(function(o){return (o.cliente||'')+' - '+(o.valor?fmt(o.valor)+'E':'');})):'')
      +footer+'</div>';
  }

  // ═══════════════════════════════════════
  // JEFE EQUIPO
  // ═══════════════════════════════════════
  else if (r==='crm_jefe'||r==='jefe') {
    var eq=u.equipo; if(!eq) continue;
    var eqV=portal.filter(function(p){return p.equipo===eq&&(p.rol==='crm_agente'||p.rol==='agente');}).map(function(p){return (p.catalogoVendedor||'').toUpperCase();}).filter(Boolean);
    var myT2=tareas.filter(function(t){return !t.eliminada&&t.estado!=='hecha'&&eqV.includes((t.agente||'').toUpperCase());});
    var myI2=inc.filter(function(i){return !i.eliminada&&i.estado!=='cerrada'&&i.estado!=='resuelta';});
    var myO2=ops.filter(function(o){return !o.eliminada&&!['ganada','perdida','cerrada_ganada','cerrada_perdida'].includes(o.estado||o.etapa)&&eqV.includes((o.agente||o.agenteId||'').toUpperCase());});
    var pipe3=myO2.reduce(function(s,o){return s+(parseInt(o.valor)||0);},0);
    subject='Equipo '+eq+': '+myT2.length+' tareas, '+myI2.length+' inc, '+fmt(pipe3)+'E';
    body=hdr(eq==='WIKUK'?'#166534':'#92400E','Equipo '+eq,hoyStr+' - Semana '+sem)
      +'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'
      +'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(myT2.length,'Tareas','#F59E0B')+kpi(myI2.length,'Incidencias','#EF4444')+kpi(fmt(pipe3)+'E','Pipeline','#1E3A5F')+'</tr></table>'
      +blk('#FEF3C7','#F59E0B','Tareas equipo',myT2.slice(0,5).map(function(t){return t.titulo||'';}))
      +blk('#FEE2E2','#EF4444','Incidencias',myI2.slice(0,3).map(function(i){return (i.titulo||i.tipo||'')+(i.clienteNombre?' - '+i.clienteNombre:'');}))
      +footer+'</div>';
  }

  // ═══════════════════════════════════════
  // CALIDAD
  // ═══════════════════════════════════════
  else if (r==='tipologia' && (u.vendor==='CALIDAD'||uid.indexOf('cal')>=0||uid.indexOf('resp_cal')>=0)) {
    var incCal=inc.filter(function(i){return !i.eliminada&&(i.tipo==='calidad'||i.tipo==='Calidad')&&i.estado!=='cerrada'&&i.estado!=='resuelta';});
    var incCerr=inc.filter(function(i){return !i.eliminada&&(i.tipo==='calidad'||i.tipo==='Calidad')&&(i.estado==='cerrada'||i.estado==='resuelta')&&i.causaRaiz;});
    var mRech=muestras.filter(function(m){return m.estado==='ko'&&!m.eliminada;});
    var mOk=muestras.filter(function(m){return (m.estado==='positivo'||m.estado==='pedido')&&!m.eliminada;});
    if(incCal.length===0&&mRech.length===0&&incCerr.length===0) continue;
    subject='Calidad: '+incCal.length+' incidencias, '+mRech.length+' muestras rechazadas';
    body=hdr('#7C3AED','Informe de Calidad',hoyStr)
      +'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'
      +'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(incCal.length,'Inc. abiertas','#EF4444')+kpi(mRech.length,'Rechazadas','#F59E0B')+kpi(mOk.length,'Aprobadas','#22C55E')+'</tr></table>'
      +blk('#FEE2E2','#EF4444','Incidencias de calidad abiertas',incCal.slice(0,5).map(function(i){return '<b>'+(i.clienteNombre||i.cliente||'')+'</b>'+(i.subtipo?' ('+i.subtipo+')':'')+': '+(i.descripcion||i.titulo||'').substring(0,80)+(i.productoNombre?' - Prod: '+i.productoNombre:'')+(i.lote?' - Lote: '+i.lote:'');}))
      +(incCerr.length>0?blk('#F0FDF4','#22C55E','Cerradas con analisis ('+incCerr.length+')',incCerr.slice(0,3).map(function(i){return '<b>'+(i.clienteNombre||'')+'</b> - Causa: '+(i.causaRaiz||'?')+' - Accion: '+(i.accionCorrectiva||'?')+(i.costeIncidente?' - Coste: '+i.costeIncidente+'E':'')+(i.recurrente?' <span style="color:#DC2626">RECURRENTE</span>':'');})):'')
      +blk('#FEF3C7','#F59E0B','Muestras rechazadas',mRech.slice(0,5).map(function(m){return '<b>'+(m.prod||'')+'</b> - '+(m.cliente||'')+': <span style="color:#DC2626">'+(m.motivo||'Sin motivo')+'</span> - "'+(m.nota||'').substring(0,60)+'"';}))
      +blk('#F0FDF4','#22C55E','Muestras aprobadas',mOk.slice(0,5).map(function(m){return '<b>'+(m.prod||'')+'</b> - '+(m.cliente||'');}))
      +footer+'</div>';
  }

  // ═══════════════════════════════════════
  // I+D
  // ═══════════════════════════════════════
  else if (r==='tipologia' && (u.vendor==='I+D'||u.vendor==='ID'||uid.indexOf('id')>=0||uid.indexOf('resp_id')>=0)) {
    var mRech2=muestras.filter(function(m){return m.estado==='ko'&&!m.eliminada;});
    var mOk2=muestras.filter(function(m){return (m.estado==='positivo'||m.estado==='pedido')&&!m.eliminada;});
    var mPend2=muestras.filter(function(m){return m.estado==='pendiente'&&!m.eliminada;});
    var pryFail=proyectos.filter(function(p){return (p.estado==='cerrado_perdido'||p.estado==='cerrado_sin_exito')&&!p.eliminada;});
    var pryOk2=proyectos.filter(function(p){return p.estado==='cerrado_exito'&&!p.eliminada;});
    var pryAct2=proyectos.filter(function(p){return p.estado==='activo'&&!p.eliminada;});
    var opsNuevas=ops.filter(function(o){return !o.eliminada&&!['ganada','perdida','cerrada_ganada','cerrada_perdida'].includes(o.estado||o.etapa);});
    if(mRech2.length===0&&mOk2.length===0&&pryAct2.length===0) continue;
    subject='I+D: '+mRech2.length+' rechazadas, '+mOk2.length+' OK, '+pryAct2.length+' proyectos';
    body=hdr('#2563EB','Informe I+D',hoyStr)
      +'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'
      +'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(mOk2.length,'Aprobadas','#22C55E')+kpi(mRech2.length,'Rechazadas','#EF4444')+kpi(mPend2.length,'Pendientes','#F59E0B')+kpi(pryAct2.length,'Proyectos','#3B82F6')+'</tr></table>'
      +blk('#FEE2E2','#EF4444','Muestras rechazadas - por que? (mejora)',mRech2.slice(0,6).map(function(m){return '<b>'+(m.prod||'')+'</b> ('+(m.cliente||'')+'): <span style="color:#DC2626">'+(m.motivo||'Sin motivo')+'</span> - "'+(m.nota||'').substring(0,80)+'"';}))
      +blk('#F0FDF4','#22C55E','Muestras con exito - que funciona?',mOk2.slice(0,5).map(function(m){return '<b>'+(m.prod||'')+'</b> - '+(m.cliente||'')+': '+(m.motivo||'Aprobada');}))
      +(pryFail.length>0?blk('#FEF2F2','#DC2626','Proyectos sin exito - lecciones',pryFail.slice(0,3).map(function(p){return '<b>'+(p.nombre||'')+'</b>: '+(p.motivoCierre||'Sin motivo')+' - "'+(p.notaCierre||'').substring(0,60)+'"';})):'')
      +(pryOk2.length>0?blk('#F0FDF4','#16A34A','Proyectos con exito',pryOk2.slice(0,3).map(function(p){return '<b>'+(p.nombre||'')+'</b>: "'+(p.notaCierre||'Completado').substring(0,60)+'"';})):'')
      +blk('#EFF6FF','#3B82F6','Proyectos activos ('+pryAct2.length+')',pryAct2.slice(0,5).map(function(p){return '<b>'+(p.nombre||'')+'</b> - '+(p.progreso||0)+'%';}))
      +blk('#FFFBEB','#D97706','Oportunidades de mercado',opsNuevas.slice(0,5).map(function(o){return '<b>'+(o.cliente||'')+'</b>: '+(o.notas||o.descripcion||'').toString().substring(0,80);}))
      +footer+'</div>';
  }

  // ═══════════════════════════════════════
  // LOGISTICA
  // ═══════════════════════════════════════
  else if (r==='tipologia' && (u.vendor==='LOGISTICA'||uid.indexOf('log')>=0||uid.indexOf('resp_log')>=0)) {
    var incLog=inc.filter(function(i){return !i.eliminada&&(i.tipo==='logistica'||i.tipo==='Logistica')&&i.estado!=='cerrada'&&i.estado!=='resuelta';});
    var incStk=inc.filter(function(i){return !i.eliminada&&(i.tipo==='stock'||i.tipo==='Stock')&&i.estado!=='cerrada';});
    if(incLog.length===0&&incStk.length===0) continue;
    subject='Logistica: '+incLog.length+' incidencias, '+incStk.length+' alertas stock';
    body=hdr('#0EA5E9','Informe de Logistica',hoyStr)
      +'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'
      +'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(incLog.length,'Inc. logistica','#EF4444')+kpi(incStk.length,'Alertas stock','#F59E0B')+'</tr></table>'
      +blk('#FEE2E2','#EF4444','Incidencias de logistica',incLog.slice(0,5).map(function(i){return '<b>'+(i.clienteNombre||'')+'</b>'+(i.subtipo?' ('+i.subtipo+')':'')+': '+(i.descripcion||i.titulo||'').substring(0,80);}))
      +blk('#FEF3C7','#F59E0B','Alertas de stock',incStk.slice(0,5).map(function(i){return '<b>'+(i.clienteNombre||'')+'</b>: '+(i.descripcion||i.titulo||'').substring(0,80);}))
      +footer+'</div>';
  }

  // ═══════════════════════════════════════
  // PRODUCCION
  // ═══════════════════════════════════════
  else if (r==='tipologia' && (u.vendor==='PRODUCCION'||uid.indexOf('prod')>=0||uid.indexOf('resp_prd')>=0)) {
    var incProd=inc.filter(function(i){return !i.eliminada&&(i.tipo==='produccion'||i.tipo==='Produccion')&&i.estado!=='cerrada';});
    var pryInd=proyectos.filter(function(p){return p.estado==='activo'&&!p.eliminada;});
    var hitosP=[];
    pryInd.forEach(function(p){
      (p.hitos||[]).forEach(function(h){
        if(!h.hecho&&(h.responsable==='produccion'||h.responsable==='industrial')) hitosP.push({proy:p.nombre,nombre:h.nombre,fecha:h.fecha||''});
      });
    });
    if(incProd.length===0&&pryInd.length===0&&hitosP.length===0) continue;
    subject='Produccion: '+incProd.length+' incidencias, '+pryInd.length+' proyectos, '+hitosP.length+' hitos';
    body=hdr('#D97706','Informe de Produccion',hoyStr)
      +'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'
      +'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(incProd.length,'Incidencias','#EF4444')+kpi(pryInd.length,'Proyectos','#3B82F6')+kpi(hitosP.length,'Hitos pend.','#F59E0B')+'</tr></table>'
      +blk('#FEE2E2','#EF4444','Incidencias de produccion',incProd.slice(0,5).map(function(i){return '<b>'+(i.clienteNombre||'')+'</b>'+(i.subtipo?' ('+i.subtipo+')':'')+': '+(i.descripcion||i.titulo||'').substring(0,80);}))
      +blk('#EFF6FF','#3B82F6','Proyectos industriales activos',pryInd.slice(0,5).map(function(p){return '<b>'+(p.nombre||'')+'</b> - '+(p.progreso||0)+'%';}))
      +blk('#FEF3C7','#F59E0B','Hitos pendientes produccion',hitosP.slice(0,5).map(function(h){return '<b>'+h.proy+'</b>: '+h.nombre+(h.fecha?' - '+h.fecha:'');}))
      +footer+'</div>';
  }

  else continue;

  // SEND
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM||process.env.SMTP_USER,
      to: u.email, subject: subject,
      html: '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden">'+body+'</div>',
    });
    sent++;
    console.log('[SUMMARY] Sent '+r+' -> '+u.email+' ('+u.nombre+')');
  } catch(e) { console.error('[SUMMARY] FAIL '+u.email+': '+e.message); }
}

console.log('[SUMMARY] Done: '+sent+' emails');
return res.status(200).json({ok:true,sent:sent,users:Object.keys(users).length});
```

} catch(error) {
console.error(’[SUMMARY] ERROR:’, error);
return res.status(500).json({error:error.message||‘Unknown error’});
}
};
