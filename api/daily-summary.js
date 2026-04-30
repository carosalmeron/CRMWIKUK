var nodemailer = require(‘nodemailer’);
var https = require(‘https’);
var FB = ‘https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents’;

function httpGet(u) {
return new Promise(function(r) {
https.get(u, function(s) {
var d = ‘’;
s.on(‘data’, function(c) { d += c; });
s.on(‘end’, function() { try { r(JSON.parse(d)); } catch(e) { r({}); } });
}).on(‘error’, function() { r({}); });
});
}

function pv(v) {
if (!v) return ‘’;
if (v.stringValue !== undefined) return v.stringValue;
if (v.integerValue !== undefined) return parseInt(v.integerValue);
if (v.doubleValue !== undefined) return parseFloat(v.doubleValue);
if (v.booleanValue !== undefined) return v.booleanValue;
if (v.arrayValue) return (v.arrayValue.values || []).map(pv);
if (v.mapValue) { var o = {}; Object.entries(v.mapValue.fields || {}).forEach(function(e) { o[e[0]] = pv(e[1]); }); return o; }
return ‘’;
}

function fbR(c) {
return httpGet(FB + ‘/’ + c + ‘?pageSize=500’).then(function(d) {
if (!d || !d.documents) return [];
return d.documents.map(function(doc) {
var o = { id: doc.name.split(’/’).pop() };
Object.entries(doc.fields || {}).forEach(function(e) { o[e[0]] = pv(e[1]); });
return o;
});
}).catch(function() { return []; });
}

function hdr(bg, t, s) { return ‘<div style="background:'+bg+';color:#fff;padding:20px 24px;border-radius:14px 14px 0 0"><h2 style="margin:0 0 4px;font-size:18px">’+t+’</h2><p style="margin:0;font-size:13px;opacity:.7">’+s+’</p></div>’; }
function blk(bg, b, t, items) { if (!items || !items.length) return ‘’; return ‘<div style="margin-bottom:16px;padding:12px 16px;background:'+bg+';border-radius:10px;border-left:4px solid '+b+'"><p style="margin:0 0 6px;font-size:13px;font-weight:700;color:'+b+'">’+t+’</p>’+items.map(function(x){return ‘<p style="margin:4px 0;font-size:12px;color:#475569;line-height:1.5">’+x+’</p>’;}).join(’’)+’</div>’; }
function kpi(v, l, c) { return ‘<td style="background:'+c+'15;border-radius:10px;padding:12px;text-align:center"><p style="margin:0;font-size:20px;font-weight:800;color:'+c+'">’+v+’</p><p style="margin:2px 0 0;font-size:10px;color:#64748B">’+l+’</p></td>’; }
function sep(t) { return ‘<div style="margin:20px 0 12px;padding-bottom:8px;border-bottom:2px solid #E2E8F0"><p style="margin:0;font-size:14px;font-weight:800;color:#0F172A">’+t+’</p></div>’; }

var ID_MAP = {ik1:‘CARLOSG’,ik2:‘RICARDO’,ik3:‘RPIEDRA’,ik4:‘AZARCO’,jl:‘JLGARCIA’,w1:‘CARLOSG’,w2:‘TROUILLE’,ANTONIO:‘AZARCO’,AGUSTIN:‘ACRUZ’};
function rv(ag) { var u=(ag||’’).toUpperCase(); return ID_MAP[ag]||ID_MAP[u]||u; }
function ism(f,vd) { return (f||’’).toUpperCase()===vd||rv(f)===vd; }
function fechaMatch(fecha,target) { if(!fecha)return false; var p=fecha.split(’/’); if(p.length!==3)return false; var dd=parseInt(p[0]),mm=parseInt(p[1]),yy=parseInt(p[2]); if(yy<100)yy+=2000; return dd===target.getDate()&&(mm-1)===target.getMonth()&&yy===target.getFullYear(); }

module.exports = async function handler(req, res) {
try {
var tr = nodemailer.createTransport({ host:process.env.SMTP_HOST||‘smtp.gmail.com’, port:parseInt(process.env.SMTP_PORT||‘587’), secure:false, auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}, tls:{rejectUnauthorized:false} });

```
var hoy = new Date();
var esViernes = hoy.getDay() === 5;
var hoyStr = hoy.toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
var sem = Math.ceil(((hoy-new Date(hoy.getFullYear(),0,1))/86400000+new Date(hoy.getFullYear(),0,1).getDay()+1)/7);
var lunes = new Date(hoy); lunes.setDate(hoy.getDate()-(hoy.getDay()||7)+1);
var domingo = new Date(lunes); domingo.setDate(lunes.getDate()+6);
var lunesStr = lunes.toISOString().split('T')[0];
var domingoStr = domingo.toISOString().split('T')[0];
var hoyISO = hoy.toISOString().split('T')[0];
var ayer = new Date(hoy); ayer.setDate(hoy.getDate()-1);
var ayerStr = ayer.toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long'});
var ft = '<div style="text-align:center;padding-top:16px"><a href="https://crmwikuk.vercel.app" style="display:inline-block;padding:14px 28px;background:#1E3A5F;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px">Abrir CRM</a></div>';

// Cargar TODO en paralelo
var all = await Promise.all([fbR('portal_users'),fbR('tareas'),fbR('incidencias'),fbR('estrategias'),fbR('oportunidades'),fbR('muestras'),fbR('proyectos'),fbR('visitas')]);
var portal=all[0], tareas=all[1], incDB=all[2], est=all[3], ops=all[4], mu=all[5], pry=all[6], vis=all[7];

var queue = [];
var agentes = portal.filter(function(p){return (p.rol==='crm_agente'||p.rol==='agente')&&p.catalogoVendedor;});

for (var i=0; i<portal.length; i++) {
  var pu=portal[i]; if(!pu.email)continue;
  var rol=pu.rol||'crm_agente', vd=(pu.catalogoVendedor||'').toUpperCase(), nm=pu.nombre||pu.id;
  try {
    if (rol==='crm_agente'||rol==='agente') {
      if(!vd)continue;
      var myVSem=vis.filter(function(v){return parseInt(v.semana||0)===sem&&(ism(v.agente,vd)||ism(v.agenteId,vd));});
      var myT=tareas.filter(function(t){return !t.eliminada&&t.estado!=='hecha'&&(ism(t.agente,vd)||ism(t.agenteId,vd));});
      var myI=incDB.filter(function(x){return !x.eliminada&&x.estado!=='cerrada'&&x.estado!=='resuelta'&&(ism(x.agente,vd)||ism(x.autor,vd));});
      var myE=est.filter(function(x){return !x.eliminada&&(x.estado==='en_curso'||x.estado==='pendiente_aprobacion')&&ism(x.agente,vd);});
      var myEDone=est.filter(function(x){return !x.eliminada&&x.estado==='completada'&&parseInt(x.semana||0)===sem&&ism(x.agente,vd);});
      var myO=ops.filter(function(x){return !x.eliminada&&['ganada','perdida'].indexOf(x.estado||x.etapa)===-1&&(ism(x.agente,vd)||ism(x.agenteId,vd));});
      var myOGan=ops.filter(function(x){return !x.eliminada&&(x.estado==='ganada'||x.etapa==='ganada')&&parseInt(x.semana||0)===sem&&(ism(x.agente,vd)||ism(x.agenteId,vd));});
      var myMDone=mu.filter(function(x){return !x.eliminada&&(x.estado==='positivo'||x.estado==='pedido')&&parseInt(x.semana||0)===sem&&ism(x.agente,vd);});
      var myMKO=mu.filter(function(x){return !x.eliminada&&x.estado==='ko'&&parseInt(x.semana||0)===sem&&ism(x.agente,vd);});
      var myTDone=tareas.filter(function(t){return !t.eliminada&&t.estado==='hecha'&&parseInt(t.semana||0)===sem&&(ism(t.agente,vd)||ism(t.agenteId,vd));});
      var pp=myO.reduce(function(s,o){return s+(parseInt(o.valor)||0);},0);
      var vPSem=myVSem.filter(function(v){return v.resultado==='pedido';}).length;
      var myHitos=[];
      pry.filter(function(p){return !p.eliminada&&p.estado==='activo';}).forEach(function(p){(p.hitos||[]).forEach(function(h){if(h.hecho)return;var resp=(h.responsable||'').toUpperCase();if(!ism(resp,vd)&&resp)return;var f=h.fecha||'';var fISO=f.indexOf('/')>=0?f.split('/').reverse().join('-'):f;if((fISO>=lunesStr&&fISO<=domingoStr)||(fISO&&fISO<hoyISO))myHitos.push({proy:p.nombre||'',hito:h.nombre||'',vencido:fISO<hoyISO});});});
      // Ayer
      var myVAyer=myVSem.filter(function(v){return fechaMatch(v.fecha,ayer);});
      var vPAyer=myVAyer.filter(function(v){return v.resultado==='pedido';}).length;
      var myEDoneAyer=est.filter(function(x){return !x.eliminada&&x.estado==='completada'&&ism(x.agente,vd)&&fechaMatch(x.fecha,ayer);});
      var myMDoneAyer=mu.filter(function(x){return !x.eliminada&&(x.estado==='positivo'||x.estado==='pedido')&&ism(x.agente,vd)&&fechaMatch(x.fecha,ayer);});
      var myMKOAyer=mu.filter(function(x){return !x.eliminada&&x.estado==='ko'&&ism(x.agente,vd)&&fechaMatch(x.fecha,ayer);});
      var myTDoneAyer=tareas.filter(function(t){return !t.eliminada&&t.estado==='hecha'&&(ism(t.agente,vd)||ism(t.agenteId,vd))&&fechaMatch(t.fechaCierre||t.fecha,ayer);});
      var myOActAyer=[];
      myO.forEach(function(o){(o.actividad||[]).forEach(function(a){if(fechaMatch(a.fecha,ayer))myOActAyer.push({nombre:o.nombre||o.cliente||'',texto:a.texto||''});});});
      var myIAyer=incDB.filter(function(x){return !x.eliminada&&(ism(x.agente,vd)||ism(x.autor,vd))&&fechaMatch(x.fecha,ayer);});

      if(esViernes){
        if(myVSem.length+myT.length+myI.length+myO.length+myHitos.length===0)continue;
        var vl=myVSem.map(function(v){var ic=v.resultado==='pedido'?'✅':v.resultado==='llamada'?'📞':'👋';var nt=v.notas||v.nota||'';return ic+' <b>'+(v.clienteNombre||v.cliente||'')+'</b>'+(nt?'<br/><span style="color:#64748B;font-size:11px;padding-left:24px">'+nt+'</span>':'');});
        var logros=[];
        myOGan.forEach(function(o){logros.push('🏆 <b>'+(o.nombre||o.cliente||'')+'</b>');});
        myEDone.forEach(function(e){logros.push('✅ <b>'+(e.cliente||'')+'</b>');});
        myMDone.forEach(function(m){logros.push('📦✅ <b>'+(m.prod||m.producto||'')+'</b>');});
        myTDone.forEach(function(t){logros.push('✅ <b>'+(t.titulo||t.texto||'')+'</b>');});
        var pend=[];
        myHitos.forEach(function(h){pend.push((h.vencido?'⚠️':'📍')+' <b>'+h.hito+'</b> — '+h.proy);});
        myT.slice(0,5).forEach(function(t){pend.push('📌 <b>'+(t.titulo||t.texto||'')+'</b>');});
        var sub='📊 Semanal '+nm+' Sem.'+sem+': '+myVSem.length+' visitas, '+vPSem+' pedidos';
        var body=hdr('#1E3A5F','📊 Resumen Semanal — '+nm,'Semana '+sem+' — '+hoyStr)+'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px"><table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(myVSem.length,'Visitas','#22C55E')+kpi(vPSem,'Pedidos','#3B82F6')+kpi(myT.length,'Tareas','#F59E0B')+kpi(pp+'€','Pipeline','#1E3A5F')+'</tr></table>'+blk('#F0FDF4','#22C55E','Visitas ('+myVSem.length+')',vl)+blk('#DBEAFE','#3B82F6','Logros ('+logros.length+')',logros)+blk('#FFF7ED','#F59E0B','Pendiente',pend)+blk('#FEE2E2','#EF4444','Incidencias ('+myI.length+')',myI.slice(0,4).map(function(x){return '<b>'+(x.tipo||'')+'</b> '+(x.clienteNombre||'');}))+blk('#F5F3FF','#7C3AED','Oportunidades ('+myO.length+')',myO.slice(0,4).map(function(x){return '<b>'+(x.nombre||x.cliente||'')+'</b> — '+(parseInt(x.valor)||0)+'€';}))+ft+'</div>';
        queue.unshift({to:pu.email,subject:sub,html:'<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden">'+body+'</div>'});
      } else {
        var totalAyer=myVAyer.length+myOActAyer.length+myEDoneAyer.length+myMDoneAyer.length+myIAyer.length;
        if(totalAyer===0&&myT.length+myHitos.length===0)continue;
        var vlA=myVAyer.map(function(v){var ic=v.resultado==='pedido'?'✅':v.resultado==='llamada'?'📞':'👋';var nt=v.notas||v.nota||'';return ic+' <b>'+(v.clienteNombre||v.cliente||'')+'</b>'+(nt?'<br/><span style="color:#64748B;font-size:11px;padding-left:24px">'+nt+'</span>':'');});
        var lA=[]; myEDoneAyer.forEach(function(e){lA.push('✅ <b>'+(e.cliente||'')+'</b>');}); myMDoneAyer.forEach(function(m){lA.push('📦✅ <b>'+(m.prod||m.producto||'')+'</b>');}); myTDoneAyer.forEach(function(t){lA.push('✅ <b>'+(t.titulo||t.texto||'')+'</b>');});
        var oA=myOActAyer.map(function(a){return '💼 <b>'+a.nombre+'</b>'+(a.texto?' — '+a.texto:'');});
        var iA=myIAyer.map(function(x){return '🚨 <b>'+(x.tipo||'')+'</b> '+(x.clienteNombre||'');});
        var pend2=[]; myHitos.forEach(function(h){pend2.push((h.vencido?'⚠️':'📍')+' <b>'+h.hito+'</b> — '+h.proy);}); myT.slice(0,5).forEach(function(t){pend2.push('📌 <b>'+(t.titulo||t.texto||'')+'</b>');});
        var sub='📋 Diario '+nm+' — '+ayerStr+': '+myVAyer.length+' visitas';
        var body=hdr('#1E3A5F','📋 Actividad de Ayer — '+nm,ayerStr+' — Semana '+sem)+'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px"><table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(myVAyer.length,'Visitas ayer','#22C55E')+kpi(vPAyer,'Pedidos','#3B82F6')+kpi(totalAyer,'Gestiones','#F59E0B')+kpi(myVSem.length,'Sem. acum.','#1E3A5F')+'</tr></table>'+blk('#F0FDF4','#22C55E','Visitas ayer ('+myVAyer.length+')',vlA)+blk('#EFF6FF','#1E3A5F','Oportunidades ayer ('+myOActAyer.length+')',oA)+blk('#DBEAFE','#3B82F6','Logros ayer ('+lA.length+')',lA)+blk('#FEE2E2','#EF4444','Incidencias ayer ('+myIAyer.length+')',iA)+sep('⏳ Pendiente esta semana')+blk('#FFF7ED','#F59E0B','Hitos + Tareas',pend2)+blk('#F5F3FF','#7C3AED','Pipeline ('+myO.length+' — '+pp+'€)',myO.slice(0,3).map(function(x){return '💼 <b>'+(x.nombre||x.cliente||'')+'</b> — '+(parseInt(x.valor)||0)+'€';}))+ft+'</div>';
        queue.unshift({to:pu.email,subject:sub,html:'<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden">'+body+'</div>'});
      }
    } else if (rol==='crm_director'||rol==='director'||rol==='ceo') {
      var aV=vis.filter(function(v){return parseInt(v.semana||0)===sem;});
      var aVAyer=aV.filter(function(v){return fechaMatch(v.fecha,ayer);});
      var aI=incDB.filter(function(x){return !x.eliminada&&x.estado!=='cerrada'&&x.estado!=='resuelta';});
      var aO=ops.filter(function(o){return !o.eliminada&&['ganada','perdida'].indexOf(o.estado||o.etapa)===-1;});
      var aP=aO.reduce(function(s,o){return s+(parseInt(o.valor)||0);},0);
      var visSource=esViernes?aV:aVAyer;
      var subDir=esViernes?'Direccion Sem.'+sem+': '+aV.length+' visitas':'Diario Direccion — '+ayerStr;
      var vBlocks='';
      for(var a=0;a<agentes.length;a++){
        var ag=agentes[a], avd=(ag.catalogoVendedor||'').toUpperCase(), anm=ag.nombre||ag.id;
        var agV=visSource.filter(function(v){return ism(v.agente,avd)||ism(v.agenteId,avd);});
        if(agV.length===0)continue;
        var agPed=agV.filter(function(v){return v.resultado==='pedido';}).length;
        vBlocks+='<div style="margin-bottom:16px;background:#fff;border-radius:12px;border:1px solid #E2E8F0;overflow:hidden"><div style="padding:12px 16px;border-bottom:1px solid #E2E8F0"><b>'+anm+'</b> <span style="padding:3px 10px;border-radius:99px;background:#22C55E15;color:#22C55E;font-size:11px;font-weight:700">'+agV.length+' vis</span> <span style="padding:3px 10px;border-radius:99px;background:#3B82F615;color:#3B82F6;font-size:11px;font-weight:700">'+agPed+' ped</span></div><div style="padding:10px 16px">';
        agV.forEach(function(v){var ic=v.resultado==='pedido'?'✅':'👋';var nt=v.notas||v.nota||'';vBlocks+='<p style="margin:3px 0;font-size:12px;color:#475569">'+ic+' <b>'+(v.clienteNombre||v.cliente||'')+'</b>'+(nt?' — '+nt:'')+'</p>';});
        vBlocks+='</div></div>';
      }
      var body2=hdr('#0F172A',esViernes?'📊 Resumen Semanal':'📋 Actividad de Ayer',(esViernes?'Semana '+sem:'Ayer: '+ayerStr)+' — '+hoyStr)+'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px"><table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(visSource.length,esViernes?'Visitas sem.':'Visitas ayer','#22C55E')+kpi(aI.length,'Incidencias','#EF4444')+kpi(aP+'€','Pipeline','#3B82F6')+kpi(aO.length,'Ops','#7C3AED')+'</tr></table>'+sep('👥 Por vendedor')+vBlocks+ft+'</div>';
      queue.push({to:pu.email,subject:subDir,html:'<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden">'+body2+'</div>'});
    }
  } catch(ee) {}
}

var sent=0, errors=[];
for(var q=0;q<queue.length;q++){
  try{
    await tr.sendMail({from:process.env.SMTP_FROM||process.env.SMTP_USER,to:queue[q].to,subject:queue[q].subject,html:queue[q].html});
    sent++;
    if(q<queue.length-1)await new Promise(function(r){setTimeout(r,2000);});
  }catch(ee){errors.push(queue[q].to+':'+ee.message);}
}
return res.status(200).json({ok:true,sent:sent,queued:queue.length,tipo:esViernes?'semanal':'diario',subjects:queue.map(function(q){return q.subject;}),errors:errors});
```

} catch(err) {
return res.status(200).json({error:err.message,stack:err.stack});
}
};
