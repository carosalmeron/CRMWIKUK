module.exports = async function handler(req, res) {
try {
var nodemailer=require('nodemailer');
var https=require('https');
var FB='https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents';
function httpGet(u){return new Promise(function(r){https.get(u,function(s){var d='';s.on('data',function(c){d+=c;});s.on('end',function(){try{r(JSON.parse(d));}catch(e){r({});}});}).on('error',function(){r({});});});}
function pv(v){if(!v)return '';if(v.stringValue!==undefined)return v.stringValue;if(v.integerValue!==undefined)return parseInt(v.integerValue);if(v.doubleValue!==undefined)return parseFloat(v.doubleValue);if(v.booleanValue!==undefined)return v.booleanValue;if(v.arrayValue)return(v.arrayValue.values||[]).map(pv);if(v.mapValue){var o={};Object.entries(v.mapValue.fields||{}).forEach(function(e){o[e[0]]=pv(e[1]);});return o;}return '';}
async function fbR(c){try{var d=await httpGet(FB+'/'+c+'?pageSize=500');if(!d||!d.documents)return[];return d.documents.map(function(doc){var o={id:doc.name.split('/').pop()};Object.entries(doc.fields||{}).forEach(function(e){o[e[0]]=pv(e[1]);});return o;});}catch(e){return[];}}
function hdr(bg,t,s){return '<div style="background:'+bg+';color:#fff;padding:20px 24px;border-radius:14px 14px 0 0"><h2 style="margin:0 0 4px;font-size:18px">'+t+'</h2><p style="margin:0;font-size:13px;opacity:.7">'+s+'</p></div>';}
function blk(bg,b,t,items){if(!items||items.length===0)return '';return '<div style="margin-bottom:16px;padding:12px 16px;background:'+bg+';border-radius:10px;border-left:4px solid '+b+'"><p style="margin:0 0 6px;font-size:13px;font-weight:700;color:'+b+'">'+t+'</p>'+items.map(function(x){return '<p style="margin:2px 0;font-size:12px;color:#475569">'+x+'</p>';}).join('')+'</div>';}
function kpi(v,l,c){return '<td style="background:'+c+'15;border-radius:10px;padding:12px;text-align:center"><p style="margin:0;font-size:20px;font-weight:800;color:'+c+'">'+v+'</p><p style="margin:2px 0 0;font-size:10px;color:#64748B">'+l+'</p></td>';}
var ID_MAP={ik1:'CARLOSG',ik2:'RICARDO',ik3:'RPIEDRA',ik4:'AZARCO',jl:'JLGARCIA',w1:'CARLOSG',w2:'TROUILLE',ANTONIO:'AZARCO',AGUSTIN:'ACRUZ'};
function resolveVendor(ag){var u=(ag||'').toUpperCase();return ID_MAP[ag]||ID_MAP[u]||u;}
var tr=nodemailer.createTransport({host:process.env.SMTP_HOST||'smtp.gmail.com',port:parseInt(process.env.SMTP_PORT||'587'),secure:false,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS},tls:{rejectUnauthorized:false}});
var hoy=new Date();
var hoyStr=hoy.toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
var sem=Math.ceil(((hoy-new Date(hoy.getFullYear(),0,1))/86400000+new Date(hoy.getFullYear(),0,1).getDay()+1)/7);
var ft='<div style="text-align:center;padding-top:16px"><a href="https://crmwikuk.vercel.app" style="display:inline-block;padding:14px 28px;background:#1E3A5F;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px">Abrir CRM</a></div>';
var portal=await fbR('portal_users');
var tareas=await fbR('tareas');
var inc=await fbR('incidencias');
var est=await fbR('estrategias');
var ops=await fbR('oportunidades');
var mu=await fbR('muestras');
var vis=[];try{vis=await fbR('visitas');}catch(e){}
function isMyItem(field,vd){var f=(field||'').toUpperCase();return f===vd||resolveVendor(field)===vd;}
var emailBodies={};
for(var i=0;i<portal.length;i++){
var pu=portal[i];if(!pu.email)continue;
var rol=pu.rol||'crm_agente';
var vd=(pu.catalogoVendedor||'').toUpperCase();
var nm=pu.nombre||pu.id;
var sub='',body='';
try{
if(rol==='crm_agente'||rol==='agente'){
if(!vd)continue;
var myV=vis.filter(function(v){return parseInt(v.semana||0)===sem&&(isMyItem(v.agente,vd)||isMyItem(v.agenteId,vd));});
var myT=tareas.filter(function(t){return !t.eliminada&&t.estado!=='hecha'&&(isMyItem(t.agente,vd)||isMyItem(t.agenteId,vd));});
var myI=inc.filter(function(x){return !x.eliminada&&x.estado!=='cerrada'&&x.estado!=='resuelta'&&(isMyItem(x.agente,vd)||isMyItem(x.autor,vd));});
var myE=est.filter(function(x){return !x.eliminada&&x.estado==='en_curso'&&isMyItem(x.agente,vd);});
var myO=ops.filter(function(x){return !x.eliminada&&['ganada','perdida','cerrada_ganada','cerrada_perdida'].indexOf(x.estado||x.etapa)===-1&&(isMyItem(x.agente,vd)||isMyItem(x.agenteId,vd));});
var myM=mu.filter(function(x){return !x.eliminada&&x.estado==='pendiente'&&isMyItem(x.agente,vd);});
var pp=myO.reduce(function(s,o){return s+(parseInt(o.valor)||0);},0);
var vP=myV.filter(function(v){return v.resultado==='pedido';}).length;
if(myV.length+myT.length+myI.length+myE.length+myO.length+myM.length===0)continue;
var vl=myV.map(function(v){var ic=v.resultado==='pedido'?'✅':v.resultado==='llamada'?'📞':v.resultado==='no_contesta'?'📵':'👋';return ic+' <b>'+(v.clienteNombre||v.cliente||'')+'</b>'+(v.notas||v.nota?' — '+(v.notas||v.nota||'').substring(0,80):'');});
sub='CRM Sem.'+sem+' | '+nm+': '+myV.length+' visitas, '+vP+' pedidos';
body=hdr('#1E3A5F','Buenos dias, '+nm,'Semana '+sem+' — '+hoyStr)+'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'+'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(myV.length,'Visitas','#22C55E')+kpi(vP,'Pedidos','#3B82F6')+kpi(myT.length,'Tareas','#F59E0B')+kpi(pp+'€','Pipeline','#1E3A5F')+'</tr></table>'+blk('#F0FDF4','#22C55E','Visitas semana '+sem,vl)+blk('#FEF3C7','#F59E0B','Tareas ('+myT.length+')',myT.slice(0,5).map(function(t){return '<b>'+(t.titulo||t.texto||'')+'</b>';}))+blk('#FEE2E2','#EF4444','Incidencias ('+myI.length+')',myI.slice(0,4).map(function(x){return '<b>'+(x.tipo||'')+'</b> '+(x.clienteNombre||'');}))+blk('#DBEAFE','#3B82F6','Estrategias ('+myE.length+')',myE.slice(0,4).map(function(x){return '<b>'+(x.cliente||x.clienteNombre||'')+'</b>';}))+blk('#F5F3FF','#7C3AED','Muestras ('+myM.length+')',myM.slice(0,4).map(function(x){return '<b>'+(x.prod||x.producto||'')+'</b> '+(x.cliente||'');}))+ft+'</div>';
}else if(rol==='crm_director'||rol==='director'||rol==='ceo'){
var aV=vis.filter(function(v){return parseInt(v.semana||0)===sem;});
var aT=tareas.filter(function(t){return !t.eliminada&&t.estado!=='hecha';});
var aI=inc.filter(function(x){return !x.eliminada&&x.estado!=='cerrada'&&x.estado!=='resuelta';});
var aO=ops.filter(function(o){return !o.eliminada&&['ganada','perdida'].indexOf(o.estado||o.etapa)===-1;});
var aP=aO.reduce(function(s,o){return s+(parseInt(o.valor)||0);},0);
var am={};for(var j=0;j<aV.length;j++){var av=aV[j];var resolved=resolveVendor(av.agente||av.agenteId||'?');if(!am[resolved])am[resolved]={n:0,p:0};am[resolved].n++;if(av.resultado==='pedido')am[resolved].p++;}
var al=[];var aks=Object.keys(am);for(var k=0;k<aks.length;k++){var key=aks[k];var dd=am[key];var p2=portal.find(function(p){return(p.catalogoVendedor||'').toUpperCase()===key;});al.push('<b>'+(p2?p2.nombre:key)+'</b>: '+dd.n+' visitas, '+dd.p+' pedidos');}
sub='Direccion Sem.'+sem+': '+aV.length+' visitas, '+aP+'€';
body=hdr('#0F172A','Informe de Direccion','Semana '+sem+' — '+hoyStr)+'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'+'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(aV.length,'Visitas','#22C55E')+kpi(aT.length,'Tareas','#F59E0B')+kpi(aI.length,'Incidencias','#EF4444')+kpi(aP+'€','Pipeline','#3B82F6')+'</tr></table>'+blk('#F0FDF4','#22C55E','Actividad por agente',al)+blk('#FEF3C7','#F59E0B','Tareas ('+aT.length+')',aT.slice(0,5).map(function(t){return '<b>'+(t.titulo||t.texto||'')+'</b>';}))+blk('#FEE2E2','#EF4444','Incidencias ('+aI.length+')',aI.slice(0,4).map(function(x){return '<b>'+(x.tipo||'')+'</b> '+(x.clienteNombre||'');}))+ft+'</div>';
}else{continue;}
if(!sub||!body)continue;
if(!emailBodies[pu.email])emailBodies[pu.email]={subjects:[],parts:[]};
emailBodies[pu.email].subjects.push(sub);
emailBodies[pu.email].parts.push(body);
}catch(ee){}}
var sent=0,errors=[];
var emails=Object.keys(emailBodies);
for(var e=0;e<emails.length;e++){
var em=emails[e];
var eb=emailBodies[em];
var finalSub=eb.subjects.length>1?'CRM Sem.'+sem+' — Resumen completo':eb.subjects[0];
try{
await tr.sendMail({from:process.env.SMTP_FROM||process.env.SMTP_USER,to:em,subject:finalSub,html:'<div style="font-family:sans-serif;max-width:560px;margin:0 auto">'+eb.parts.join('<div style="height:24px;border-top:2px solid #E2E8F0;margin:12px 0"></div>')+'</div>'});
sent++;
}catch(ee){errors.push(em+':'+ee.message);}
}
return res.status(200).json({ok:true,sent:sent,emails:emails,errors:errors});
}catch(err){return res.status(200).json({error:err.message});}
};
