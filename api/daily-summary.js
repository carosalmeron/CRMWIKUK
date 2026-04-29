var nodemailer=require('nodemailer');
var https=require('https');
var FB='https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents';
function httpGet(u){return new Promise(function(r){https.get(u,function(s){var d='';s.on('data',function(c){d+=c;});s.on('end',function(){try{r(JSON.parse(d));}catch(e){r({});}});}).on('error',function(){r({});});});}
function pv(v){if(!v)return '';if(v.stringValue!==undefined)return v.stringValue;if(v.integerValue!==undefined)return parseInt(v.integerValue);if(v.doubleValue!==undefined)return parseFloat(v.doubleValue);if(v.booleanValue!==undefined)return v.booleanValue;if(v.arrayValue)return(v.arrayValue.values||[]).map(pv);if(v.mapValue){var o={};Object.entries(v.mapValue.fields||{}).forEach(function(e){o[e[0]]=pv(e[1]);});return o;}return '';}
async function fbR(c){try{var d=await httpGet(FB+'/'+c+'?pageSize=500');if(!d||!d.documents)return[];return d.documents.map(function(doc){var o={id:doc.name.split('/').pop()};Object.entries(doc.fields||{}).forEach(function(e){o[e[0]]=pv(e[1]);});return o;});}catch(e){return[];}}
function hdr(bg,t,s){return '<div style="background:'+bg+';color:#fff;padding:20px 24px;border-radius:14px 14px 0 0"><h2 style="margin:0 0 4px;font-size:18px">'+t+'</h2><p style="margin:0;font-size:13px;opacity:.7">'+s+'</p></div>';}
function blk(bg,b,t,items){if(!items||items.length===0)return '';return '<div style="margin-bottom:16px;padding:12px 16px;background:'+bg+';border-radius:10px;border-left:4px solid '+b+'"><p style="margin:0 0 6px;font-size:13px;font-weight:700;color:'+b+'">'+t+'</p>'+items.map(function(x){return '<p style="margin:4px 0;font-size:12px;color:#475569;line-height:1.5">'+x+'</p>';}).join('')+'</div>';}
function kpi(v,l,c){return '<td style="background:'+c+'15;border-radius:10px;padding:12px;text-align:center"><p style="margin:0;font-size:20px;font-weight:800;color:'+c+'">'+v+'</p><p style="margin:2px 0 0;font-size:10px;color:#64748B">'+l+'</p></td>';}
function sep(t){return '<div style="margin:20px 0 12px;padding-bottom:8px;border-bottom:2px solid #E2E8F0"><p style="margin:0;font-size:14px;font-weight:800;color:#0F172A">'+t+'</p></div>';}
var ID_MAP={ik1:'CARLOSG',ik2:'RICARDO',ik3:'RPIEDRA',ik4:'AZARCO',jl:'JLGARCIA',w1:'CARLOSG',w2:'TROUILLE',ANTONIO:'AZARCO',AGUSTIN:'ACRUZ'};
function rv(ag){var u=(ag||'').toUpperCase();return ID_MAP[ag]||ID_MAP[u]||u;}
function ism(f,vd){return(f||'').toUpperCase()===vd||rv(f)===vd;}
module.exports=async function handler(req,res){
try{
var tr=nodemailer.createTransport({host:process.env.SMTP_HOST||'smtp.gmail.com',port:parseInt(process.env.SMTP_PORT||'587'),secure:false,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS},tls:{rejectUnauthorized:false}});
var hoy=new Date();var hoyStr=hoy.toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
var sem=Math.ceil(((hoy-new Date(hoy.getFullYear(),0,1))/86400000+new Date(hoy.getFullYear(),0,1).getDay()+1)/7);
var lunes=new Date(hoy);lunes.setDate(hoy.getDate()-(hoy.getDay()||7)+1);var domingo=new Date(lunes);domingo.setDate(lunes.getDate()+6);
var lunesStr=lunes.toISOString().split('T')[0];var domingoStr=domingo.toISOString().split('T')[0];var hoyISO=hoy.toISOString().split('T')[0];
var ft='<div style="text-align:center;padding-top:16px"><a href="https://crmwikuk.vercel.app" style="display:inline-block;padding:14px 28px;background:#1E3A5F;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px">Abrir CRM</a></div>';
var portal=await fbR('portal_users');var tareas=await fbR('tareas');var inc=await fbR('incidencias');var est=await fbR('estrategias');var ops=await fbR('oportunidades');var mu=await fbR('muestras');
var pry=[];try{pry=await fbR('proyectos');}catch(e){}
var vis=[];try{vis=await fbR('visitas');}catch(e){}
var queue=[];
var agentes=portal.filter(function(p){return(p.rol==='crm_agente'||p.rol==='agente')&&p.catalogoVendedor;});
for(var i=0;i<portal.length;i++){
var pu=portal[i];if(!pu.email)continue;var rol=pu.rol||'crm_agente';var vd=(pu.catalogoVendedor||'').toUpperCase();var nm=pu.nombre||pu.id;
try{
if(rol==='crm_agente'||rol==='agente'){
if(!vd)continue;
var myV=vis.filter(function(v){return parseInt(v.semana||0)===sem&&(ism(v.agente,vd)||ism(v.agenteId,vd));});
var myT=tareas.filter(function(t){return !t.eliminada&&t.estado!=='hecha'&&(ism(t.agente,vd)||ism(t.agenteId,vd));});
var myTDone=tareas.filter(function(t){return !t.eliminada&&t.estado==='hecha'&&parseInt(t.semana||0)===sem&&(ism(t.agente,vd)||ism(t.agenteId,vd));});
var myI=inc.filter(function(x){return !x.eliminada&&x.estado!=='cerrada'&&x.estado!=='resuelta'&&(ism(x.agente,vd)||ism(x.autor,vd));});
var myE=est.filter(function(x){return !x.eliminada&&(x.estado==='en_curso'||x.estado==='pendiente_aprobacion')&&ism(x.agente,vd);});
var myEDone=est.filter(function(x){return !x.eliminada&&x.estado==='completada'&&parseInt(x.semana||0)===sem&&ism(x.agente,vd);});
var myO=ops.filter(function(x){return !x.eliminada&&['ganada','perdida','cerrada_ganada','cerrada_perdida'].indexOf(x.estado||x.etapa)===-1&&(ism(x.agente,vd)||ism(x.agenteId,vd));});
var myOGan=ops.filter(function(x){return !x.eliminada&&(x.estado==='ganada'||x.etapa==='ganada')&&parseInt(x.semana||0)===sem&&(ism(x.agente,vd)||ism(x.agenteId,vd));});
var myMPend=mu.filter(function(x){return !x.eliminada&&x.estado==='pendiente'&&ism(x.agente,vd)&&parseInt(x.semana||0)===sem;});
var myMDone=mu.filter(function(x){return !x.eliminada&&(x.estado==='positivo'||x.estado==='pedido')&&parseInt(x.semana||0)===sem&&ism(x.agente,vd);});
var myMKO=mu.filter(function(x){return !x.eliminada&&x.estado==='ko'&&parseInt(x.semana||0)===sem&&ism(x.agente,vd);});
var pp=myO.reduce(function(s,o){return s+(parseInt(o.valor)||0);},0);
var vP=myV.filter(function(v){return v.resultado==='pedido';}).length;
var myHitos=[];
pry.filter(function(p){return !p.eliminada&&p.estado==='activo';}).forEach(function(p){(p.hitos||[]).forEach(function(h){if(h.hecho)return;var resp=(h.responsable||'').toUpperCase();if(!ism(resp,vd)&&resp)return;var f=h.fecha||'';var fISO=f.indexOf('/')>=0?f.split('/').reverse().join('-'):f;var esSem=fISO>=lunesStr&&fISO<=domingoStr;var esVenc=fISO&&fISO<hoyISO;if(esSem||esVenc)myHitos.push({proy:p.nombre||'',hito:h.nombre||'',fecha:f,vencido:esVenc});});});
if(myV.length+myT.length+myI.length+myE.length+myO.length+myMPend.length+myHitos.length+myMDone.length+myEDone.length+myOGan.length===0)continue;
var vl=myV.map(function(v){var ic=v.resultado==='pedido'?'✅':v.resultado==='llamada'?'📞':v.resultado==='no_contesta'?'📵':'👋';var lb=v.resultado==='pedido'?'Pedido':v.resultado==='llamada'?'Llamada':v.resultado==='no_contesta'?'No contesta':'Visita';var nt=v.notas||v.nota||'';return ic+' <b>'+(v.clienteNombre||v.cliente||'')+'</b> — '+lb+(nt?'<br/><span style="color:#64748B;font-size:11px;padding-left:24px">'+nt+'</span>':'');});
var logros=[];
if(myOGan.length>0)myOGan.forEach(function(o){logros.push('🏆 Opo ganada: <b>'+(o.nombre||o.cliente||'')+'</b>'+(o.valor?' — '+o.valor+'€':''));});
if(myEDone.length>0)myEDone.forEach(function(e){logros.push('✅ Estrategia OK: <b>'+(e.cliente||e.clienteNombre||'')+'</b>');});
if(myMDone.length>0)myMDone.forEach(function(m){logros.push('📦✅ Muestra OK: <b>'+(m.prod||m.producto||'')+'</b> — '+(m.cliente||''));});
if(myMKO.length>0)myMKO.forEach(function(m){logros.push('📦❌ Muestra KO: <b>'+(m.prod||m.producto||'')+'</b> — '+(m.cliente||''));});
if(myTDone.length>0)myTDone.forEach(function(t){logros.push('✅ Tarea: <b>'+(t.titulo||t.texto||'')+'</b>');});
var pendItems=[];
if(myHitos.length>0)myHitos.forEach(function(h){pendItems.push((h.vencido?'⚠️':'📍')+' <b>'+h.hito+'</b> — '+h.proy+(h.fecha?' ('+(h.vencido?'VENCIDO: ':'')+h.fecha+')':''));});
var sub='Actividad '+nm+' Sem.'+sem+': '+myV.length+' visitas, '+vP+' pedidos';
var body=hdr('#1E3A5F','Buenos dias, '+nm,'Semana '+sem+' — '+hoyStr)+'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'+'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(myV.length,'Visitas','#22C55E')+kpi(vP,'Pedidos','#3B82F6')+kpi(myT.length,'Tareas','#F59E0B')+kpi(pp+'€','Pipeline','#1E3A5F')+'</tr></table>'+blk('#F0FDF4','#22C55E','Visitas semana '+sem+' ('+myV.length+')',vl)+blk('#DBEAFE','#3B82F6','Logros esta semana ('+logros.length+')',logros)+blk('#FFF7ED','#F59E0B','Pendiente — '+myHitos.length+' hitos, '+myT.length+' tareas',pendItems.concat(myT.slice(0,5).map(function(t){return '📌 <b>'+(t.titulo||t.texto||'')+'</b>'+(t.vence?' — '+t.vence:'');})))+blk('#FEE2E2','#EF4444','Incidencias ('+myI.length+')',myI.slice(0,4).map(function(x){return '<b>'+(x.tipo||'')+'</b> '+(x.clienteNombre||'')+': '+(x.descripcion||x.titulo||'').substring(0,80);}))+blk('#DBEAFE','#3B82F6','Estrategias ('+myE.length+')',myE.slice(0,4).map(function(x){return '<b>'+(x.cliente||x.clienteNombre||'')+'</b>: '+(x.texto||x.objetivo||'').substring(0,80);}))+blk('#F5F3FF','#7C3AED','Oportunidades ('+myO.length+')',myO.slice(0,4).map(function(x){return '<b>'+(x.nombre||x.cliente||'')+'</b> — '+(parseInt(x.valor)||0)+'€ ('+(x.prob||0)+'%)';}))+blk('#F5F3FF','#7C3AED','Muestras pendientes semana ('+myMPend.length+')',myMPend.slice(0,5).map(function(x){return '<b>'+(x.prod||x.producto||'')+'</b> — '+(x.cliente||x.clienteNombre||'');}))+ft+'</div>';
queue.unshift({to:pu.email,subject:sub,html:'<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden">'+body+'</div>'});
}else if(rol==='crm_director'||rol==='director'||rol==='ceo'){
var aV=vis.filter(function(v){return parseInt(v.semana||0)===sem;});
var aT=tareas.filter(function(t){return !t.eliminada&&t.estado!=='hecha';});
var aI=inc.filter(function(x){return !x.eliminada&&x.estado!=='cerrada'&&x.estado!=='resuelta';});
var aO=ops.filter(function(o){return !o.eliminada&&['ganada','perdida','cerrada_ganada','cerrada_perdida'].indexOf(o.estado||o.etapa)===-1;});
var aOGan=ops.filter(function(o){return !o.eliminada&&(o.estado==='ganada'||o.etapa==='ganada');});
var aOPerd=ops.filter(function(o){return !o.eliminada&&(o.estado==='perdida'||o.etapa==='perdida');});
var aP=aO.reduce(function(s,o){return s+(parseInt(o.valor)||0);},0);
var aE=est.filter(function(x){return !x.eliminada&&(x.estado==='en_curso'||x.estado==='pendiente_aprobacion');});
var aMPend=mu.filter(function(x){return !x.eliminada&&x.estado==='pendiente';});
var aMOk=mu.filter(function(x){return !x.eliminada&&(x.estado==='positivo'||x.estado==='pedido');});
var aMKo=mu.filter(function(x){return !x.eliminada&&x.estado==='ko';});
var aHitos=[];
pry.filter(function(p){return !p.eliminada&&p.estado==='activo';}).forEach(function(p){(p.hitos||[]).forEach(function(h){if(h.hecho)return;var f=h.fecha||'';var fISO=f.indexOf('/')>=0?f.split('/').reverse().join('-'):f;var esSem=fISO>=lunesStr&&fISO<=domingoStr;var esVenc=fISO&&fISO<hoyISO;if(esSem||esVenc)aHitos.push({proy:p.nombre||'',hito:h.nombre||'',fecha:f,vencido:esVenc,resp:h.responsable||''});});});
var vendorBlocks='';
for(var a=0;a<agentes.length;a++){
var ag=agentes[a];var avd=(ag.catalogoVendedor||'').toUpperCase();var anm=ag.nombre||ag.id;
var agV=vis.filter(function(v){return parseInt(v.semana||0)===sem&&(ism(v.agente,avd)||ism(v.agenteId,avd));});
var agT=tareas.filter(function(t){return !t.eliminada&&t.estado!=='hecha'&&(ism(t.agente,avd)||ism(t.agenteId,avd));});
var agI=inc.filter(function(x){return !x.eliminada&&x.estado!=='cerrada'&&x.estado!=='resuelta'&&(ism(x.agente,avd)||ism(x.autor,avd));});
var agE=est.filter(function(x){return !x.eliminada&&(x.estado==='en_curso'||x.estado==='pendiente_aprobacion')&&ism(x.agente,avd);});
var agO=ops.filter(function(x){return !x.eliminada&&['ganada','perdida','cerrada_ganada','cerrada_perdida'].indexOf(x.estado||x.etapa)===-1&&(ism(x.agente,avd)||ism(x.agenteId,avd));});
var agM=mu.filter(function(x){return !x.eliminada&&x.estado==='pendiente'&&ism(x.agente,avd)&&parseInt(x.semana||0)===sem;});
var agPipe=agO.reduce(function(s,o){return s+(parseInt(o.valor)||0);},0);
var agPed=agV.filter(function(v){return v.resultado==='pedido';}).length;
if(agV.length+agT.length+agI.length+agE.length+agO.length+agM.length===0)continue;
var eq=ag.equipo||'';
var eqColor=eq==='WIKUK'?'#166534':eq==='INTERKEY'?'#92400E':'#1E3A5F';
var eqBadge=eq?'<span style="display:inline-block;padding:2px 8px;border-radius:99px;background:'+eqColor+'15;color:'+eqColor+';font-size:10px;font-weight:700;margin-left:8px">'+eq+'</span>':'';
vendorBlocks+='<div style="margin-bottom:16px;background:#fff;border-radius:12px;border:1px solid #E2E8F0;overflow:hidden">';
vendorBlocks+='<div style="padding:12px 16px;background:'+eqColor+'08;border-bottom:1px solid #E2E8F0;display:flex;justify-content:space-between;align-items:center"><div><span style="font-size:14px;font-weight:800;color:#0F172A">'+anm+'</span>'+eqBadge+'</div><div style="display:flex;gap:8px">';
vendorBlocks+='<span style="padding:3px 10px;border-radius:99px;background:#22C55E15;color:#22C55E;font-size:11px;font-weight:700">'+agV.length+' vis</span>';
vendorBlocks+='<span style="padding:3px 10px;border-radius:99px;background:#3B82F615;color:#3B82F6;font-size:11px;font-weight:700">'+agPed+' ped</span>';
if(agPipe>0)vendorBlocks+='<span style="padding:3px 10px;border-radius:99px;background:#1E3A5F15;color:#1E3A5F;font-size:11px;font-weight:700">'+agPipe+'€</span>';
vendorBlocks+='</div></div>';
vendorBlocks+='<div style="padding:10px 16px">';
agV.forEach(function(v){var ic=v.resultado==='pedido'?'✅':v.resultado==='llamada'?'📞':v.resultado==='no_contesta'?'📵':'👋';var nt=v.notas||v.nota||'';vendorBlocks+='<p style="margin:3px 0;font-size:12px;color:#475569;line-height:1.5">'+ic+' <b>'+(v.clienteNombre||v.cliente||'')+'</b>'+(nt?' — '+nt:'')+'</p>';});
if(agE.length>0){vendorBlocks+='<p style="margin:8px 0 2px;font-size:10px;font-weight:700;color:#3B82F6">ESTRATEGIAS ('+agE.length+')</p>';agE.forEach(function(e){vendorBlocks+='<p style="margin:2px 0;font-size:11px;color:#64748B">🎯 <b>'+(e.cliente||e.clienteNombre||'')+'</b>: '+(e.texto||e.objetivo||'').substring(0,60)+'</p>';});}
if(agO.length>0){vendorBlocks+='<p style="margin:8px 0 2px;font-size:10px;font-weight:700;color:#F59E0B">OPORTUNIDADES ('+agO.length+')</p>';agO.slice(0,3).forEach(function(o){vendorBlocks+='<p style="margin:2px 0;font-size:11px;color:#64748B">💼 <b>'+(o.nombre||o.cliente||'')+'</b> — '+(parseInt(o.valor)||0)+'€</p>';});}
if(agM.length>0){vendorBlocks+='<p style="margin:8px 0 2px;font-size:10px;font-weight:700;color:#7C3AED">MUESTRAS ('+agM.length+')</p>';agM.slice(0,3).forEach(function(m){vendorBlocks+='<p style="margin:2px 0;font-size:11px;color:#64748B">📦 <b>'+(m.prod||m.producto||'')+'</b> — '+(m.cliente||'')+'</p>';});}
if(agI.length>0){vendorBlocks+='<p style="margin:8px 0 2px;font-size:10px;font-weight:700;color:#EF4444">INCIDENCIAS ('+agI.length+')</p>';agI.slice(0,2).forEach(function(x){vendorBlocks+='<p style="margin:2px 0;font-size:11px;color:#64748B">🚨 <b>'+(x.tipo||'')+'</b> '+(x.clienteNombre||'')+': '+(x.descripcion||x.titulo||'').substring(0,50)+'</p>';});}
vendorBlocks+='</div></div>';
}
var hitosHtml='';
if(aHitos.length>0){
var hl=aHitos.map(function(h){var rU=portal.find(function(p){return(p.catalogoVendedor||'').toUpperCase()===(h.resp||'').toUpperCase();});return(h.vencido?'⚠️':'📍')+' <b>'+h.hito+'</b> — '+h.proy+(rU?' ('+rU.nombre+')':'')+(h.fecha?' — '+(h.vencido?'VENCIDO ':'')+h.fecha:'');});
hitosHtml=blk('#FFF7ED','#F59E0B','Hitos esta semana ('+aHitos.length+')',hl);
}
var sub2='Direccion Sem.'+sem+': '+aV.length+' visitas, '+aO.length+' ops, '+aP+'€';
var body2=hdr('#0F172A','Informe de Direccion','Semana '+sem+' — '+hoyStr)+'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'+'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(aV.length,'Visitas','#22C55E')+kpi(aI.length,'Incidencias','#EF4444')+kpi(aO.length+' ('+aP+'€)','Pipeline','#3B82F6')+kpi(aE.length,'Estrategias','#7C3AED')+'</tr></table>'+'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(aMOk.length,'Muestras OK','#22C55E')+kpi(aMKo.length,'Muestras KO','#EF4444')+kpi(aMPend.length,'Pendientes','#F59E0B')+kpi(aOGan.length+'/'+aOPerd.length,'Gan/Perd','#3B82F6')+'</tr></table>'+sep('👥 Detalle por vendedor')+vendorBlocks+hitosHtml+blk('#FEF3C7','#F59E0B','Tareas pendientes ('+aT.length+')',aT.slice(0,8).map(function(t){var tAg=portal.find(function(p){return ism(p.catalogoVendedor,rv(t.agente||t.agenteId||''));});return '📌 <b>'+(t.titulo||t.texto||'')+'</b>'+(tAg?' — '+tAg.nombre:'');}))+blk('#FEE2E2','#EF4444','Incidencias abiertas ('+aI.length+')',aI.slice(0,6).map(function(x){return '🚨 <b>'+(x.tipo||'')+'</b> '+(x.clienteNombre||'')+': '+(x.descripcion||x.titulo||'').substring(0,80);}))+ft+'</div>';
queue.push({to:pu.email,subject:sub2,html:'<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden">'+body2+'</div>'});
}}catch(ee){}}
var sent=0,errors=[];
for(var q=0;q<queue.length;q++){try{await tr.sendMail({from:process.env.SMTP_FROM||process.env.SMTP_USER,to:queue[q].to,subject:queue[q].subject,html:queue[q].html});sent++;if(q<queue.length-1)await new Promise(function(r){setTimeout(r,2000);});}catch(ee){errors.push(queue[q].to+':'+ee.message);}}
return res.status(200).json({ok:true,sent:sent,queued:queue.length,subjects:queue.map(function(q){return q.subject;}),errors:errors});
}catch(err){return res.status(200).json({error:err.message});}
};
