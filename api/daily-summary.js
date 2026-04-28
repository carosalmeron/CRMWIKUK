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
var docs=[], nextPage=null, intentos=0;
do {
var url=FB_BASE+’/’+col+’?pageSize=300’+(nextPage?’&pageToken=’+nextPage:’’);
var d = await httpGet(url);
if (!d || !d.documents) break;
d.documents.forEach(function(doc) {
var obj = { id: doc.name.split(’/’).pop() };
Object.entries(doc.fields || {}).forEach(function(e) { obj[e[0]] = pv(e[1]); });
docs.push(obj);
});
nextPage=d.nextPageToken||null;
intentos++;
} while(nextPage&&intentos<5);
return docs;
} catch(e) { return []; }
}

function hdr(bg,t,s){return ‘<div style="background:'+bg+';color:#fff;padding:20px 24px;border-radius:14px 14px 0 0"><h2 style="margin:0 0 4px;font-size:18px">’+t+’</h2><p style="margin:0;font-size:13px;opacity:.7">’+s+’</p></div>’;}
function blk(bg,b,t,items){if(!items||items.length===0)return ‘’;return ‘<div style="margin-bottom:16px;padding:12px 16px;background:'+bg+';border-radius:10px;border-left:4px solid '+b+'"><p style="margin:0 0 6px;font-size:13px;font-weight:700;color:'+b+'">’+t+’</p>’+items.map(function(x){return ‘<p style="margin:2px 0;font-size:12px;color:#475569">’+x+’</p>’;}).join(’’)+’</div>’;}
function kpi(v,l,c){return ‘<td style="background:'+c+'15;border-radius:10px;padding:12px;text-align:center"><p style="margin:0;font-size:20px;font-weight:800;color:'+c+'">’+v+’</p><p style="margin:2px 0 0;font-size:10px;color:#64748B">’+l+’</p></td>’;}
function row(icon,t,sub,color){return ‘<tr><td style="width:36px;text-align:center;font-size:18px;vertical-align:top;padding:6px 0">’+icon+’</td><td style="padding:6px 8px"><p style="margin:0;font-size:13px;font-weight:600;color:#0F172A">’+t+’</p><p style="margin:2px 0 0;font-size:11px;color:'+(color||'#64748B')+'">’+sub+’</p></td></tr>’;}

var RESULTADO_LABELS={pedido:‘Pedido’,llamada:‘Llamada’,visita_sin_pedido:‘Visita s/pedido’,no_contesta:‘No contesta’,primera_visita:‘Primera visita’};
var RESULTADO_ICONS={pedido:‘✅’,llamada:‘📞’,visita_sin_pedido:‘👋’,no_contesta:‘📵’,primera_visita:‘🆕’};

module.exports = async function handler(req, res) {
try {
if (!process.env.SMTP_USER) return res.status(200).json({error:‘SMTP not configured’});

```
var transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  tls: { rejectUnauthorized: false },
});

var hoy = new Date();
var ayer = new Date(hoy); ayer.setDate(hoy.getDate()-1);
var ayerStr = ayer.toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
var hoyStr = hoy.toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
var sem = Math.ceil(((hoy-new Date(hoy.getFullYear(),0,1))/86400000+new Date(hoy.getFullYear(),0,1).getDay()+1)/7);
var footer = '<div style="text-align:center;padding-top:16px"><a href="https://crmwikuk.vercel.app" style="display:inline-block;padding:14px 28px;background:#1E3A5F;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px">Abrir CRM</a><p style="margin:20px 0 0;font-size:10px;color:#94A3B8">CRM Grupo Consolidado · Resumen automatico</p></div>';

var portal = await fbRead('portal_users');
var tareas = await fbRead('tareas');
var incAll = await fbRead('incidencias');
var estAll = await fbRead('estrategias');
var opsAll = await fbRead('oportunidades');
var muAll = await fbRead('muestras');
var pryAll = await fbRead('proyectos');
var visAll = await fbRead('visitas');

console.log('[SUMMARY] Data: portal='+portal.length+' tareas='+tareas.length+' inc='+incAll.length+' ops='+opsAll.length+' vis='+visAll.length);

var sent = 0;
var errors = [];

for (var i = 0; i < portal.length; i++) {
  var pu = portal[i];
  if (!pu.email) continue;
  var rol = pu.rol || 'crm_agente';
  var vendor = (pu.catalogoVendedor || '').toUpperCase();
  var nombre = pu.nombre || pu.id;
  var equipo = pu.equipo || '';
  var subject = '';
  var body = '';

  try {
    // ── COMERCIAL ──
    if (rol === 'crm_agente' || rol === 'agente') {
      if (!vendor) continue;

      // Visitas de esta semana
      var myV=visAll.filter(function(v){return parseInt(v.semana||0)===sem&&((v.agente||'').toUpperCase()===vendor||(v.agenteId||'').toUpperCase()===vendor);});
      // Tareas pendientes
      var myT=tareas.filter(function(t){return !t.eliminada&&t.estado!=='hecha'&&((t.agente||'').toUpperCase()===vendor||(t.agenteId||'').toUpperCase()===vendor);});
      // Incidencias abiertas
      var myI=incAll.filter(function(x){return !x.eliminada&&x.estado!=='cerrada'&&x.estado!=='resuelta'&&((x.agente||'').toUpperCase()===vendor||(x.autor||'').toUpperCase()===vendor);});
      // Estrategias en curso
      var myE=estAll.filter(function(x){return !x.eliminada&&x.estado==='en_curso'&&(x.agente||'').toUpperCase()===vendor;});
      // Oportunidades activas
      var myO=opsAll.filter(function(x){return !x.eliminada&&['ganada','perdida','cerrada_ganada','cerrada_perdida'].indexOf(x.estado||x.etapa)===-1&&((x.agente||'').toUpperCase()===vendor||(x.agenteId||'').toUpperCase()===vendor);});
      // Muestras pendientes
      var myM=muAll.filter(function(x){return !x.eliminada&&x.estado==='pendiente'&&(x.agente||'').toUpperCase()===vendor;});
      var pipe=myO.reduce(function(s,o){return s+(parseInt(o.valor)||0);},0);

      if(myV.length+myT.length+myI.length+myE.length+myO.length+myM.length===0) continue;

      // Agrupar visitas por resultado
      var vPedido=myV.filter(function(v){return v.resultado==='pedido';});
      var vSinPed=myV.filter(function(v){return v.resultado!=='pedido';});

      subject='CRM Sem.'+sem+' | '+nombre+': '+myV.length+' visitas, '+myT.length+' tareas, '+myO.length+' ops';

      body=hdr('#1E3A5F','Buenos dias, '+nombre,'Resumen semana '+sem+' — '+hoyStr)
        +'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'
        // KPIs
        +'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'
        +kpi(myV.length,'Visitas','#22C55E')
        +kpi(vPedido.length,'Pedidos','#3B82F6')
        +kpi(myT.length,'Tareas','#F59E0B')
        +kpi((pipe>1000?(pipe/1000).toFixed(0)+'K':pipe)+'€','Pipeline','#1E3A5F')
        +'</tr></table>'

        // Visitas realizadas
        +(myV.length>0?'<div style="margin-bottom:16px;padding:14px 16px;background:#F0FDF4;border-radius:10px;border-left:4px solid #22C55E"><p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#22C55E">👥 Visitas semana '+sem+' ('+myV.length+')</p><table width="100%" style="border-collapse:collapse">'+myV.map(function(v){
          var rIcon=RESULTADO_ICONS[v.resultado]||'👋';
          var rLabel=RESULTADO_LABELS[v.resultado]||v.resultado||'';
          var notas=v.notas||v.nota||'';
          return row(rIcon, v.clienteNombre||v.cliente||'—', rLabel+(notas?' — '+notas.substring(0,80):''), v.resultado==='pedido'?'#22C55E':'#64748B');
        }).join('')+'</table></div>':'')

        // Tareas pendientes
        +blk('#FEF3C7','#F59E0B','📌 Tareas pendientes ('+myT.length+')',myT.slice(0,5).map(function(t){return '<b>'+(t.titulo||t.texto||'')+'</b>'+(t.vence?' — Vence: '+t.vence:'');}))

        // Incidencias
        +blk('#FEE2E2','#EF4444','🚨 Incidencias abiertas ('+myI.length+')',myI.slice(0,4).map(function(x){return '<b>'+(x.tipo||'')+'</b> '+(x.clienteNombre||x.cliente||'')+': '+(x.descripcion||x.titulo||'').substring(0,60);}))

        // Estrategias
        +blk('#DBEAFE','#3B82F6','🎯 Estrategias en curso ('+myE.length+')',myE.slice(0,4).map(function(x){return '<b>'+(x.cliente||x.clienteNombre||'')+'</b>: '+(x.texto||x.objetivo||'').substring(0,60);}))

        // Oportunidades
        +blk('#FEF3C7','#F59E0B','💼 Oportunidades activas ('+myO.length+')',myO.slice(0,4).map(function(x){return '<b>'+(x.nombre||x.cliente||'')+'</b> — '+(parseInt(x.valor)||0)+'€ ('+(x.prob||0)+'%)';}))

        // Muestras
        +blk('#F5F3FF','#7C3AED','📦 Muestras pendientes ('+myM.length+')',myM.slice(0,4).map(function(x){return '<b>'+(x.prod||x.producto||'')+'</b> — '+(x.cliente||x.clienteNombre||'');}))

        +footer+'</div>';
    }

    // ── DIRECTOR / CEO ──
    else if (rol==='crm_director'||rol==='director'||rol==='ceo') {
      var allV=visAll.filter(function(v){return parseInt(v.semana||0)===sem;});
      var allT=tareas.filter(function(t){return !t.eliminada&&t.estado!=='hecha';});
      var allI=incAll.filter(function(x){return !x.eliminada&&x.estado!=='cerrada'&&x.estado!=='resuelta';});
      var allO=opsAll.filter(function(o){return !o.eliminada&&['ganada','perdida','cerrada_ganada','cerrada_perdida'].indexOf(o.estado||o.etapa)===-1;});
      var allPipe=allO.reduce(function(s,o){return s+(parseInt(o.valor)||0);},0);

      // Visitas por agente
      var visPorAgente={};
      allV.forEach(function(v){
        var ag=v.agente||v.agenteId||'?';
        if(!visPorAgente[ag]) visPorAgente[ag]={total:0,pedidos:0,clientes:[]};
        visPorAgente[ag].total++;
        if(v.resultado==='pedido') visPorAgente[ag].pedidos++;
        var cn=v.clienteNombre||v.cliente||'';
        if(cn&&visPorAgente[ag].clientes.indexOf(cn)<0) visPorAgente[ag].clientes.push(cn);
      });

      subject='CRM Direccion Sem.'+sem+': '+allV.length+' visitas, '+allT.length+' tareas, '+(allPipe>1000?(allPipe/1000).toFixed(0)+'K':allPipe)+'€ pipeline';

      body=hdr('#0F172A','Informe de Direccion','Semana '+sem+' — '+hoyStr)
        +'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'
        +'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'
        +kpi(allV.length,'Visitas','#22C55E')
        +kpi(allT.length,'Tareas','#F59E0B')
        +kpi(allI.length,'Incidencias','#EF4444')
        +kpi((allPipe>1000?(allPipe/1000).toFixed(0)+'K':allPipe)+'€','Pipeline','#3B82F6')
        +'</tr></table>'

        // Resumen por agente
        +(Object.keys(visPorAgente).length>0?'<div style="margin-bottom:16px;padding:14px 16px;background:#F0FDF4;border-radius:10px;border-left:4px solid #22C55E"><p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#22C55E">👥 Actividad por agente</p><table width="100%" style="border-collapse:collapse">'+Object.keys(visPorAgente).map(function(ag){
          var d=visPorAgente[ag];
          var pU=portal.find(function(p){return (p.catalogoVendedor||'').toUpperCase()===ag.toUpperCase();});
          var agNombre=pU?pU.nombre:ag;
          return row('🧑‍💼', agNombre+': '+d.total+' visitas, '+d.pedidos+' pedidos', d.clientes.slice(0,5).join(', '));
        }).join('')+'</table></div>':'')

        +blk('#FEF3C7','#F59E0B','📌 Tareas pendientes ('+allT.length+')',allT.slice(0,5).map(function(t){return '<b>'+(t.titulo||t.texto||'')+'</b> — '+(t.agente||'');}))
        +blk('#FEE2E2','#EF4444','🚨 Incidencias ('+allI.length+')',allI.slice(0,5).map(function(x){return '<b>'+(x.tipo||'')+'</b> '+(x.clienteNombre||'')+': '+(x.descripcion||x.titulo||'').substring(0,60);}))
        +blk('#DBEAFE','#3B82F6','💼 Pipeline ('+allO.length+' ops)',allO.slice(0,5).map(function(x){return '<b>'+(x.nombre||x.cliente||'')+'</b> — '+(parseInt(x.valor)||0)+'€';}))
        +footer+'</div>';
    }

    // ── JEFE DE VENTAS ──
    else if (rol==='crm_jefe'||rol==='jefe') {
      if (!equipo) continue;
      var eqV=portal.filter(function(p){return p.equipo===equipo&&(p.rol==='crm_agente'||p.rol==='agente');}).map(function(p){return (p.catalogoVendedor||'').toUpperCase();}).filter(Boolean);
      var tE=tareas.filter(function(t){return !t.eliminada&&t.estado!=='hecha'&&eqV.indexOf((t.agente||'').toUpperCase())>=0;});
      var iE=incAll.filter(function(x){return !x.eliminada&&x.estado!=='cerrada'&&x.estado!=='resuelta';});
      var oE=opsAll.filter(function(o){return !o.eliminada&&['ganada','perdida','cerrada_ganada','cerrada_perdida'].indexOf(o.estado||o.etapa)===-1&&eqV.indexOf((o.agente||o.agenteId||'').toUpperCase())>=0;});
      var vE=visAll.filter(function(v){return parseInt(v.semana||0)===sem&&eqV.indexOf((v.agente||v.agenteId||'').toUpperCase())>=0;});
      var pE=oE.reduce(function(s,o){return s+(parseInt(o.valor)||0);},0);
      subject='Equipo '+equipo+' Sem.'+sem+': '+vE.length+' visitas, '+tE.length+' tareas';
      body=hdr(equipo==='WIKUK'?'#166534':'#92400E','Equipo '+equipo,'Semana '+sem+' — '+hoyStr)
        +'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'
        +'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(vE.length,'Visitas','#22C55E')+kpi(tE.length,'Tareas','#F59E0B')+kpi(iE.length,'Incidencias','#EF4444')+kpi((pE>1000?(pE/1000).toFixed(0)+'K':pE)+'€','Pipeline','#3B82F6')+'</tr></table>'
        +blk('#F0FDF4','#22C55E','Visitas equipo',vE.slice(0,8).map(function(v){return (RESULTADO_ICONS[v.resultado]||'👋')+' <b>'+(v.clienteNombre||v.cliente||'')+'</b> — '+(RESULTADO_LABELS[v.resultado]||'')+(v.notas||v.nota?': '+(v.notas||v.nota||'').substring(0,50):'');}))
        +blk('#FEF3C7','#F59E0B','Tareas equipo',tE.slice(0,5).map(function(t){return (t.titulo||t.texto||'')+' — '+(t.agente||'');}))
        +blk('#FEE2E2','#EF4444','Incidencias',iE.slice(0,3).map(function(x){return (x.titulo||x.tipo||'')+(x.clienteNombre?' — '+x.clienteNombre:'');}))
        +footer+'</div>';
    }

    // ── CALIDAD ──
    else if (rol==='tipologia' && (vendor==='CALIDAD'||pu.id.indexOf('cal')>=0)) {
      var iC=incAll.filter(function(x){return !x.eliminada&&(x.tipo==='calidad'||x.tipo==='Calidad')&&x.estado!=='cerrada'&&x.estado!=='resuelta';});
      var mR=muAll.filter(function(x){return x.estado==='ko'&&!x.eliminada;});
      var mOk=muAll.filter(function(x){return (x.estado==='positivo'||x.estado==='pedido')&&!x.eliminada;});
      if(iC.length===0&&mR.length===0) continue;
      subject='Calidad Sem.'+sem+': '+iC.length+' incidencias, '+mR.length+' rechazadas';
      body=hdr('#7C3AED','Informe de Calidad','Semana '+sem+' — '+hoyStr)
        +'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'
        +'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(iC.length,'Inc. abiertas','#EF4444')+kpi(mR.length,'Rechazadas','#F59E0B')+kpi(mOk.length,'Aprobadas','#22C55E')+'</tr></table>'
        +blk('#FEE2E2','#EF4444','Incidencias calidad',iC.slice(0,5).map(function(x){return '<b>'+(x.clienteNombre||'')+'</b>'+(x.subtipo?' ('+x.subtipo+')':'')+': '+(x.descripcion||x.titulo||'').substring(0,80);}))
        +blk('#FEF3C7','#F59E0B','Muestras rechazadas',mR.slice(0,5).map(function(x){return '<b>'+(x.prod||'')+'</b> '+(x.cliente||'');}))
        +footer+'</div>';
    }

    // ── I+D ──
    else if (rol==='tipologia' && (vendor==='I+D'||vendor==='ID'||pu.id.indexOf('resp_id')>=0)) {
      var mR2=muAll.filter(function(x){return x.estado==='ko'&&!x.eliminada;});
      var mO2=muAll.filter(function(x){return (x.estado==='positivo'||x.estado==='pedido')&&!x.eliminada;});
      var mPe=muAll.filter(function(x){return x.estado==='pendiente'&&!x.eliminada;});
      var pA=pryAll.filter(function(x){return x.estado==='activo'&&!x.eliminada;});
      if(mR2.length===0&&mO2.length===0&&pA.length===0) continue;
      subject='I+D Sem.'+sem+': '+mR2.length+' rechazadas, '+mO2.length+' OK, '+pA.length+' proyectos';
      body=hdr('#2563EB','Informe I+D','Semana '+sem+' — '+hoyStr)
        +'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'
        +'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(mO2.length,'Aprobadas','#22C55E')+kpi(mR2.length,'Rechazadas','#EF4444')+kpi(mPe.length,'Pendientes','#F59E0B')+kpi(pA.length,'Proyectos','#3B82F6')+'</tr></table>'
        +blk('#FEE2E2','#EF4444','Rechazadas',mR2.slice(0,6).map(function(x){return '<b>'+(x.prod||'')+'</b> ('+(x.cliente||'')+'): '+(x.motivo||'Sin motivo');}))
        +blk('#F0FDF4','#22C55E','Aprobadas',mO2.slice(0,5).map(function(x){return '<b>'+(x.prod||'')+'</b> '+(x.cliente||'');}))
        +blk('#EFF6FF','#3B82F6','Proyectos activos',pA.slice(0,5).map(function(x){return '<b>'+(x.nombre||'')+'</b> '+(x.progreso||0)+'%';}))
        +footer+'</div>';
    }

    // ── LOGISTICA ──
    else if (rol==='tipologia' && (vendor==='LOGISTICA'||pu.id.indexOf('log')>=0)) {
      var iL=incAll.filter(function(x){return !x.eliminada&&(x.tipo==='logistica'||x.tipo==='Logistica')&&x.estado!=='cerrada';});
      if(iL.length===0) continue;
      subject='Logistica Sem.'+sem+': '+iL.length+' incidencias';
      body=hdr('#0EA5E9','Informe Logistica','Semana '+sem+' — '+hoyStr)
        +'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'
        +blk('#FEE2E2','#EF4444','Incidencias logistica',iL.slice(0,5).map(function(x){return '<b>'+(x.clienteNombre||'')+'</b>: '+(x.descripcion||x.titulo||'').substring(0,80);}))
        +footer+'</div>';
    }

    // ── PRODUCCION ──
    else if (rol==='tipologia' && (vendor==='PRODUCCION'||pu.id.indexOf('prod')>=0)) {
      var iP=incAll.filter(function(x){return !x.eliminada&&(x.tipo==='produccion'||x.tipo==='Produccion')&&x.estado!=='cerrada';});
      var pI=pryAll.filter(function(x){return x.estado==='activo'&&!x.eliminada;});
      if(iP.length===0&&pI.length===0) continue;
      subject='Produccion Sem.'+sem+': '+iP.length+' incidencias';
      body=hdr('#D97706','Informe Produccion','Semana '+sem+' — '+hoyStr)
        +'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'
        +blk('#FEE2E2','#EF4444','Incidencias produccion',iP.slice(0,5).map(function(x){return '<b>'+(x.clienteNombre||'')+'</b>: '+(x.descripcion||x.titulo||'').substring(0,80);}))
        +blk('#EFF6FF','#3B82F6','Proyectos activos',pI.slice(0,5).map(function(x){return '<b>'+(x.nombre||'')+'</b> '+(x.progreso||0)+'%';}))
        +footer+'</div>';
    }
    else { continue; }

    if (!subject || !body) continue;

    await transporter.sendMail({
      from: process.env.SMTP_FROM||process.env.SMTP_USER,
      to: pu.email,
      subject: subject,
      html: '<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">'+body+'</div>',
    });
    sent++;
    console.log('[SUMMARY] OK '+rol+' -> '+pu.email);
  } catch(emailErr) {
    errors.push(pu.email+': '+emailErr.message);
    console.error('[SUMMARY] FAIL '+pu.email+': '+emailErr.message);
  }
}

console.log('[SUMMARY] Done: '+sent+' sent');
return res.status(200).json({ok:true, sent:sent, total:portal.length, errors:errors});
```

} catch(err) {
console.error(’[SUMMARY] CRASH:’, err);
return res.status(200).json({error:err.message, stack:err.stack});
}
};
