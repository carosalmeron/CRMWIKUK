const nodemailer = require(‘nodemailer’);
const https = require(‘https’);
const FB_BASE = ‘https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents’;

function httpGet(url) {
return new Promise(function(resolve, reject) {
https.get(url, function(res) {
var data = ‘’;
res.on(‘data’, function(c) { data += c; });
res.on(‘end’, function() { try { resolve(JSON.parse(data)); } catch(e) { resolve({}); } });
}).on(‘error’, function(e) { resolve({}); });
});
}

function pv(v) {
if (!v) return ‘’;
if (v.stringValue !== undefined) return v.stringValue;
if (v.integerValue !== undefined) return parseInt(v.integerValue);
if (v.doubleValue !== undefined) return parseFloat(v.doubleValue);
if (v.booleanValue !== undefined) return v.booleanValue;
if (v.nullValue !== undefined) return null;
if (v.arrayValue) return (v.arrayValue.values || []).map(pv);
if (v.mapValue) { var o={}; Object.entries(v.mapValue.fields||{}).forEach(function(e){o[e[0]]=pv(e[1]);}); return o; }
return ‘’;
}

async function fbRead(col) {
try {
var d = await httpGet(FB_BASE + ‘/’ + col + ‘?pageSize=500’);
if (!d || !d.documents) return [];
return d.documents.map(function(doc) {
var obj = { id: doc.name.split(’/’).pop() };
Object.entries(doc.fields || {}).forEach(function(e) { obj[e[0]] = pv(e[1]); });
return obj;
});
} catch(e) { return []; }
}

function hdr(bg,t,s){return ‘<div style="background:'+bg+';color:#fff;padding:20px 24px;border-radius:14px 14px 0 0"><h2 style="margin:0 0 4px;font-size:18px">’+t+’</h2><p style="margin:0;font-size:13px;opacity:.7">’+s+’</p></div>’;}
function blk(bg,b,t,items){if(!items||items.length===0)return ‘’;return ‘<div style="margin-bottom:16px;padding:12px 16px;background:'+bg+';border-radius:10px;border-left:4px solid '+b+'"><p style="margin:0 0 6px;font-size:13px;font-weight:700;color:'+b+'">’+t+’</p>’+items.map(function(x){return ‘<p style="margin:2px 0;font-size:12px;color:#475569">’+x+’</p>’;}).join(’’)+’</div>’;}
function kpi(v,l,c){return ‘<td style="background:'+c+'15;border-radius:10px;padding:12px;text-align:center"><p style="margin:0;font-size:20px;font-weight:800;color:'+c+'">’+v+’</p><p style="margin:2px 0 0;font-size:10px;color:#64748B">’+l+’</p></td>’;}

var RI={pedido:‘✅’,llamada:‘📞’,visita_sin_pedido:‘👋’,no_contesta:‘📵’,primera_visita:‘🆕’};
var RL={pedido:‘Pedido’,llamada:‘Llamada’,visita_sin_pedido:‘Visita s/pedido’,no_contesta:‘No contesta’,primera_visita:‘Primera visita’};

module.exports = async function handler(req, res) {
try {
if (!process.env.SMTP_USER) return res.status(200).json({error:‘SMTP not configured’});
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
var footer = ‘<div style="text-align:center;padding-top:16px"><a href="https://crmwikuk.vercel.app" style="display:inline-block;padding:14px 28px;background:#1E3A5F;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px">Abrir CRM</a><p style="margin:20px 0 0;font-size:10px;color:#94A3B8">CRM Grupo Consolidado</p></div>’;
var portal=await fbRead(‘portal_users’);
var tareas=await fbRead(‘tareas’);
var incAll=await fbRead(‘incidencias’);
var estAll=await fbRead(‘estrategias’);
var opsAll=await fbRead(‘oportunidades’);
var muAll=await fbRead(‘muestras’);
var visAll=await fbRead(‘visitas’);
var sent=0, errors=[];
for(var i=0;i<portal.length;i++){
var pu=portal[i];
if(!pu.email) continue;
var rol=pu.rol||‘crm_agente’;
var vendor=(pu.catalogoVendedor||’’).toUpperCase();
var nombre=pu.nombre||pu.id;
var equipo=pu.equipo||’’;
var subject=’’, body=’’;
try{
if(rol===‘crm_agente’||rol===‘agente’){
if(!vendor) continue;
var myV=visAll.filter(function(v){return parseInt(v.semana||0)===sem&&((v.agente||’’).toUpperCase()===vendor||(v.agenteId||’’).toUpperCase()===vendor);});
var myT=tareas.filter(function(t){return !t.eliminada&&t.estado!==‘hecha’&&((t.agente||’’).toUpperCase()===vendor||(t.agenteId||’’).toUpperCase()===vendor);});
var myI=incAll.filter(function(x){return !x.eliminada&&x.estado!==‘cerrada’&&x.estado!==‘resuelta’&&((x.agente||’’).toUpperCase()===vendor||(x.autor||’’).toUpperCase()===vendor);});
var myE=estAll.filter(function(x){return !x.eliminada&&x.estado===‘en_curso’&&(x.agente||’’).toUpperCase()===vendor;});
var myO=opsAll.filter(function(x){return !x.eliminada&&[‘ganada’,‘perdida’,‘cerrada_ganada’,‘cerrada_perdida’].indexOf(x.estado||x.etapa)===-1&&((x.agente||’’).toUpperCase()===vendor||(x.agenteId||’’).toUpperCase()===vendor);});
var myM=muAll.filter(function(x){return !x.eliminada&&x.estado===‘pendiente’&&(x.agente||’’).toUpperCase()===vendor;});
var pipe=myO.reduce(function(s,o){return s+(parseInt(o.valor)||0);},0);
var vPed=myV.filter(function(v){return v.resultado===‘pedido’;}).length;
if(myV.length+myT.length+myI.length+myE.length+myO.length+myM.length===0) continue;
var vh=’’;
if(myV.length>0){vh=’<div style="margin-bottom:16px;padding:14px 16px;background:#F0FDF4;border-radius:10px;border-left:4px solid #22C55E"><p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#22C55E">Visitas semana ‘+sem+’ (’+myV.length+’)</p>’;for(var vi=0;vi<myV.length;vi++){var vv=myV[vi];vh+=’<p style="margin:4px 0;font-size:12px;color:#475569">’+(RI[vv.resultado]||‘👋’)+’ <b>’+(vv.clienteNombre||vv.cliente||’’)+’</b> — ‘+(RL[vv.resultado]||’’)+((vv.notas||vv.nota)?’ — ‘+(vv.notas||vv.nota||’’).substring(0,80):’’)+’</p>’;}vh+=’</div>’;}
subject=‘CRM Sem.’+sem+’ | ‘+nombre+’: ‘+myV.length+’ visitas, ‘+vPed+’ pedidos’;
body=hdr(’#1E3A5F’,‘Buenos dias, ‘+nombre,‘Semana ‘+sem+’ — ‘+hoyStr)+’<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">’+’<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>’+kpi(myV.length,‘Visitas’,’#22C55E’)+kpi(vPed,‘Pedidos’,’#3B82F6’)+kpi(myT.length,‘Tareas’,’#F59E0B’)+kpi(pipe+‘€’,‘Pipeline’,’#1E3A5F’)+’</tr></table>’+vh+blk(’#FEF3C7’,’#F59E0B’,‘Tareas pendientes (’+myT.length+’)’,myT.slice(0,5).map(function(t){return ‘<b>’+(t.titulo||t.texto||’’)+’</b>’+(t.vence?’ — ‘+t.vence:’’);}))+blk(’#FEE2E2’,’#EF4444’,‘Incidencias (’+myI.length+’)’,myI.slice(0,4).map(function(x){return ‘<b>’+(x.tipo||’’)+’</b> ‘+(x.clienteNombre||’’)+’: ‘+(x.descripcion||x.titulo||’’).substring(0,60);}))+blk(’#DBEAFE’,’#3B82F6’,‘Estrategias (’+myE.length+’)’,myE.slice(0,4).map(function(x){return ‘<b>’+(x.cliente||x.clienteNombre||’’)+’</b>: ‘+(x.texto||x.objetivo||’’).substring(0,60);}))+blk(’#F5F3FF’,’#7C3AED’,‘Muestras pendientes (’+myM.length+’)’,myM.slice(0,4).map(function(x){return ‘<b>’+(x.prod||x.producto||’’)+’</b> — ‘+(x.cliente||x.clienteNombre||’’);}))+footer+’</div>’;
}else if(rol===‘crm_director’||rol===‘director’||rol===‘ceo’){
var aV=visAll.filter(function(v){return parseInt(v.semana||0)===sem;});
var aT=tareas.filter(function(t){return !t.eliminada&&t.estado!==‘hecha’;});
var aI=incAll.filter(function(x){return !x.eliminada&&x.estado!==‘cerrada’&&x.estado!==‘resuelta’;});
var aO=opsAll.filter(function(o){return !o.eliminada&&[‘ganada’,‘perdida’].indexOf(o.estado||o.etapa)===-1;});
var aP=aO.reduce(function(s,o){return s+(parseInt(o.valor)||0);},0);
var am={};for(var j=0;j<aV.length;j++){var av=aV[j];var ak=(av.agente||av.agenteId||’?’).toUpperCase();if(!am[ak])am[ak]={n:0,p:0,c:[]};am[ak].n++;if(av.resultado===‘pedido’)am[ak].p++;am[ak].c.push((RI[av.resultado]||‘👋’)+’ ‘+(av.clienteNombre||av.cliente||’’));}
var al=[];var aks=Object.keys(am);for(var k=0;k<aks.length;k++){var key=aks[k];var dd=am[key];var pu2=portal.find(function(p){return(p.catalogoVendedor||’’).toUpperCase()===key;});al.push(’<b>’+(pu2?pu2.nombre:key)+’</b>: ‘+dd.n+’ visitas, ‘+dd.p+’ pedidos’);}
subject=‘Direccion Sem.’+sem+’: ‘+aV.length+’ visitas, ‘+aP+‘€ pipeline’;
body=hdr(’#0F172A’,‘Informe de Direccion’,‘Semana ‘+sem+’ — ‘+hoyStr)+’<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">’+’<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>’+kpi(aV.length,‘Visitas’,’#22C55E’)+kpi(aT.length,‘Tareas’,’#F59E0B’)+kpi(aI.length,‘Incidencias’,’#EF4444’)+kpi(aP+‘€’,‘Pipeline’,’#3B82F6’)+’</tr></table>’+blk(’#F0FDF4’,’#22C55E’,‘Actividad por agente’,al)+blk(’#FEF3C7’,’#F59E0B’,‘Tareas (’+aT.length+’)’,aT.slice(0,5).map(function(t){return ‘<b>’+(t.titulo||t.texto||’’)+’</b> — ‘+(t.agente||’’);}))+blk(’#FEE2E2’,’#EF4444’,‘Incidencias (’+aI.length+’)’,aI.slice(0,5).map(function(x){return ‘<b>’+(x.tipo||’’)+’</b> ‘+(x.clienteNombre||’’)+’: ‘+(x.descripcion||x.titulo||’’).substring(0,60);}))+footer+’</div>’;
}else if(rol===‘crm_jefe’||rol===‘jefe’){
if(!equipo) continue;
var eqV2=portal.filter(function(p){return p.equipo===equipo&&(p.rol===‘crm_agente’||p.rol===‘agente’);}).map(function(p){return(p.catalogoVendedor||’’).toUpperCase();}).filter(Boolean);
var tE2=tareas.filter(function(t){return !t.eliminada&&t.estado!==‘hecha’&&eqV2.indexOf((t.agente||’’).toUpperCase())>=0;});
var iE2=incAll.filter(function(x){return !x.eliminada&&x.estado!==‘cerrada’&&x.estado!==‘resuelta’;});
var vE2=visAll.filter(function(v){return parseInt(v.semana||0)===sem&&eqV2.indexOf((v.agente||v.agenteId||’’).toUpperCase())>=0;});
subject=‘Equipo ‘+equipo+’ Sem.’+sem+’: ‘+vE2.length+’ visitas’;
body=hdr(equipo===‘WIKUK’?’#166534’:’#92400E’,‘Equipo ‘+equipo,‘Semana ‘+sem+’ — ‘+hoyStr)+’<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">’+’<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>’+kpi(vE2.length,‘Visitas’,’#22C55E’)+kpi(tE2.length,‘Tareas’,’#F59E0B’)+kpi(iE2.length,‘Incidencias’,’#EF4444’)+’</tr></table>’+blk(’#F0FDF4’,’#22C55E’,‘Visitas equipo’,vE2.slice(0,8).map(function(v){return(RI[v.resultado]||‘👋’)+’ <b>’+(v.clienteNombre||v.cliente||’’)+’</b> — ‘+(RL[v.resultado]||’’);}))+blk(’#FEF3C7’,’#F59E0B’,‘Tareas’,tE2.slice(0,5).map(function(t){return(t.titulo||’’);}))+footer+’</div>’;
}else{continue;}
if(!subject||!body) continue;
await transporter.sendMail({from:process.env.SMTP_FROM||process.env.SMTP_USER,to:pu.email,subject:subject,html:’<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">’+body+’</div>’});
sent++;
}catch(emailErr){errors.push(pu.email+’: ’+emailErr.message);}
}
return res.status(200).json({ok:true,sent:sent,total:portal.length,errors:errors});
}catch(err){return res.status(200).json({error:err.message});}
};
