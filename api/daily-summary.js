const nodemailer = require('nodemailer');
const https = require('https');
const FB_BASE = 'https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents';

function httpGet(url) {
  return new Promise(function(resolve, reject) {
    https.get(url, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() { try { resolve(JSON.parse(data)); } catch(e) { resolve({}); } });
    }).on('error', function(e) { resolve({}); });
  });
}

function pv(v) {
  if (!v) return '';
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue);
  if (v.doubleValue !== undefined) return parseFloat(v.doubleValue);
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.nullValue !== undefined) return null;
  if (v.arrayValue) return (v.arrayValue.values || []).map(pv);
  if (v.mapValue) { var o={}; Object.entries(v.mapValue.fields||{}).forEach(function(e){o[e[0]]=pv(e[1]);}); return o; }
  return '';
}

async function fbRead(col) {
  try {
    var d = await httpGet(FB_BASE + '/' + col + '?pageSize=500');
    if (!d || !d.documents) return [];
    return d.documents.map(function(doc) {
      var obj = { id: doc.name.split('/').pop() };
      Object.entries(doc.fields || {}).forEach(function(e) { obj[e[0]] = pv(e[1]); });
      return obj;
    });
  } catch(e) { return []; }
}

function hdr(bg,t,s){return '<div style="background:'+bg+';color:#fff;padding:20px 24px;border-radius:14px 14px 0 0"><h2 style="margin:0 0 4px;font-size:18px">'+t+'</h2><p style="margin:0;font-size:13px;opacity:.7">'+s+'</p></div>';}
function blk(bg,b,t,items){if(!items||items.length===0)return '';return '<div style="margin-bottom:16px;padding:12px 16px;background:'+bg+';border-radius:10px;border-left:4px solid '+b+'"><p style="margin:0 0 6px;font-size:13px;font-weight:700;color:'+b+'">'+t+'</p>'+items.map(function(x){return '<p style="margin:2px 0;font-size:12px;color:#475569">'+x+'</p>';}).join('')+'</div>';}
function kpi(v,l,c){return '<td style="background:'+c+'15;border-radius:10px;padding:12px;text-align:center"><p style="margin:0;font-size:20px;font-weight:800;color:'+c+'">'+v+'</p><p style="margin:2px 0 0;font-size:10px;color:#64748B">'+l+'</p></td>';}

module.exports = async function handler(req, res) {
  try {
    if (!process.env.SMTP_USER) return res.status(200).json({error:'SMTP not configured'});

    var transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      tls: { rejectUnauthorized: false },
    });

    var hoy = new Date();
    var hoyStr = hoy.toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
    var sem = Math.ceil(((hoy-new Date(hoy.getFullYear(),0,1))/86400000+new Date(hoy.getFullYear(),0,1).getDay()+1)/7);
    var footer = '<a href="https://crmwikuk.vercel.app" style="display:inline-block;padding:14px 28px;background:#1E3A5F;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px;margin-top:12px">Abrir CRM</a><p style="margin:20px 0 0;font-size:10px;color:#94A3B8;text-align:center">CRM Grupo Consolidado</p>';

    var portal = await fbRead('portal_users');
    var tareas = await fbRead('tareas');
    var incAll = await fbRead('incidencias');
    var estAll = await fbRead('estrategias');
    var opsAll = await fbRead('oportunidades');
    var muAll = await fbRead('muestras');
    var pryAll = await fbRead('proyectos');

    console.log('[SUMMARY] Data: portal='+portal.length+' tareas='+tareas.length+' inc='+incAll.length+' ops='+opsAll.length);

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
          var myT=tareas.filter(function(t){return !t.eliminada&&t.estado!=='hecha'&&((t.agente||'').toUpperCase()===vendor||(t.agenteId||'').toUpperCase()===vendor);});
          var myI=incAll.filter(function(x){return !x.eliminada&&x.estado!=='cerrada'&&x.estado!=='resuelta'&&((x.agente||'').toUpperCase()===vendor||(x.autor||'').toUpperCase()===vendor);});
          var myE=estAll.filter(function(x){return !x.eliminada&&x.estado==='en_curso'&&!x.resolucion&&(x.agente||'').toUpperCase()===vendor;});
          var myO=opsAll.filter(function(x){return !x.eliminada&&['ganada','perdida','cerrada_ganada','cerrada_perdida'].indexOf(x.estado||x.etapa)===-1&&((x.agente||'').toUpperCase()===vendor||(x.agenteId||'').toUpperCase()===vendor);});
          var myM=muAll.filter(function(x){return !x.eliminada&&x.estado==='pendiente'&&(x.agente||'').toUpperCase()===vendor;});
          var pipe=myO.reduce(function(s,o){return s+(parseInt(o.valor)||0);},0);
          if(myT.length+myI.length+myE.length+myO.length+myM.length===0) continue;
          subject='CRM '+hoyStr+': '+myT.length+' tareas, '+myI.length+' inc, '+myO.length+' ops';
          body=hdr('#1E3A5F','Buenos dias, '+nombre,hoyStr)
            +'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'
            +'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(myT.length,'Tareas','#F59E0B')+kpi(myO.length,'Ops','#3B82F6')+kpi(pipe+'E','Pipeline','#1E3A5F')+'</tr></table>'
            +blk('#FEF3C7','#F59E0B','Tareas pendientes ('+myT.length+')',myT.slice(0,4).map(function(t){return (t.titulo||t.texto||'')+(t.vence?' - '+t.vence:'');}))
            +blk('#FEE2E2','#EF4444','Incidencias ('+myI.length+')',myI.slice(0,3).map(function(x){return (x.titulo||x.tipo||'')+(x.clienteNombre?' - '+x.clienteNombre:'');}))
            +blk('#DBEAFE','#3B82F6','Estrategias ('+myE.length+')',myE.slice(0,3).map(function(x){return (x.cliente||'')+' - '+(x.texto||x.objetivo||'').substring(0,60);}))
            +blk('#F5F3FF','#7C3AED','Muestras pendientes ('+myM.length+')',myM.slice(0,3).map(function(x){return (x.prod||'')+' - '+(x.cliente||'');}))
            +footer+'</div>';
        }
        // ── DIRECTOR / CEO ──
        else if (rol==='crm_director'||rol==='director'||rol==='ceo') {
          var oAct=opsAll.filter(function(o){return !o.eliminada&&['ganada','perdida','cerrada_ganada','cerrada_perdida'].indexOf(o.estado||o.etapa)===-1;});
          var iAbi=incAll.filter(function(x){return !x.eliminada&&x.estado!=='cerrada'&&x.estado!=='resuelta';});
          var eAct=estAll.filter(function(x){return !x.eliminada&&x.estado==='en_curso'&&!x.resolucion;});
          var mP=muAll.filter(function(x){return !x.eliminada&&x.estado==='pendiente';});
          var pp=oAct.reduce(function(s,o){return s+(parseInt(o.valor)||0);},0);
          subject='Panel ejecutivo: '+pp+'E pipeline, '+iAbi.length+' inc';
          body=hdr('#1E3A5F','Panel ejecutivo',hoyStr)
            +'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'
            +'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(oAct.length,'Ops','#3B82F6')+kpi(iAbi.length,'Incidencias','#EF4444')+kpi(pp+'E','Pipeline','#1E3A5F')+kpi(eAct.length,'Estrategias','#7C3AED')+'</tr></table>'
            +blk('#FEE2E2','#EF4444','Incidencias ('+iAbi.length+')',iAbi.slice(0,4).map(function(x){return (x.tipo||'')+': '+(x.titulo||x.asunto||'')+(x.clienteNombre?' - '+x.clienteNombre:'');}))
            +blk('#DBEAFE','#3B82F6','Estrategias ('+eAct.length+')',eAct.slice(0,4).map(function(x){return (x.cliente||'')+' - '+(x.texto||'').substring(0,50);}))
            +blk('#F5F3FF','#7C3AED','Muestras pendientes ('+mP.length+')',mP.slice(0,3).map(function(x){return (x.prod||'')+' - '+(x.cliente||'');}))
            +footer+'</div>';
        }
        // ── JEFE ──
        else if (rol==='crm_jefe'||rol==='jefe') {
          if (!equipo) continue;
          var eqV=portal.filter(function(p){return p.equipo===equipo&&(p.rol==='crm_agente'||p.rol==='agente');}).map(function(p){return (p.catalogoVendedor||'').toUpperCase();}).filter(Boolean);
          var tE=tareas.filter(function(t){return !t.eliminada&&t.estado!=='hecha'&&eqV.indexOf((t.agente||'').toUpperCase())>=0;});
          var iE=incAll.filter(function(x){return !x.eliminada&&x.estado!=='cerrada'&&x.estado!=='resuelta';});
          var oE=opsAll.filter(function(o){return !o.eliminada&&['ganada','perdida','cerrada_ganada','cerrada_perdida'].indexOf(o.estado||o.etapa)===-1&&eqV.indexOf((o.agente||o.agenteId||'').toUpperCase())>=0;});
          var pE=oE.reduce(function(s,o){return s+(parseInt(o.valor)||0);},0);
          subject='Equipo '+equipo+': '+tE.length+' tareas, '+iE.length+' inc';
          body=hdr(equipo==='WIKUK'?'#166534':'#92400E','Equipo '+equipo,hoyStr)
            +'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'
            +'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(tE.length,'Tareas','#F59E0B')+kpi(iE.length,'Incidencias','#EF4444')+kpi(pE+'E','Pipeline','#1E3A5F')+'</tr></table>'
            +blk('#FEF3C7','#F59E0B','Tareas equipo',tE.slice(0,5).map(function(t){return t.titulo||'';}))
            +blk('#FEE2E2','#EF4444','Incidencias',iE.slice(0,3).map(function(x){return (x.titulo||x.tipo||'')+(x.clienteNombre?' - '+x.clienteNombre:'');}))
            +footer+'</div>';
        }
        // ── CALIDAD ──
        else if (rol==='tipologia' && (vendor==='CALIDAD'||pu.id.indexOf('cal')>=0)) {
          var iC=incAll.filter(function(x){return !x.eliminada&&(x.tipo==='calidad'||x.tipo==='Calidad')&&x.estado!=='cerrada'&&x.estado!=='resuelta';});
          var iCC=incAll.filter(function(x){return !x.eliminada&&(x.tipo==='calidad'||x.tipo==='Calidad')&&(x.estado==='cerrada'||x.estado==='resuelta')&&x.causaRaiz;});
          var mR=muAll.filter(function(x){return x.estado==='ko'&&!x.eliminada;});
          var mOk=muAll.filter(function(x){return (x.estado==='positivo'||x.estado==='pedido')&&!x.eliminada;});
          if(iC.length===0&&mR.length===0&&iCC.length===0) continue;
          subject='Calidad: '+iC.length+' incidencias, '+mR.length+' rechazadas';
          body=hdr('#7C3AED','Informe de Calidad',hoyStr)
            +'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'
            +'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(iC.length,'Inc. abiertas','#EF4444')+kpi(mR.length,'Rechazadas','#F59E0B')+kpi(mOk.length,'Aprobadas','#22C55E')+'</tr></table>'
            +blk('#FEE2E2','#EF4444','Incidencias calidad',iC.slice(0,5).map(function(x){return '<b>'+(x.clienteNombre||'')+'</b>'+(x.subtipo?' ('+x.subtipo+')':'')+': '+(x.descripcion||x.titulo||'').substring(0,80)+(x.lote?' Lote:'+x.lote:'');}))
            +(iCC.length>0?blk('#F0FDF4','#22C55E','Cerradas con analisis',iCC.slice(0,3).map(function(x){return '<b>'+(x.clienteNombre||'')+'</b> Causa:'+(x.causaRaiz||'?')+' Accion:'+(x.accionCorrectiva||'?')+(x.costeIncidente?' Coste:'+x.costeIncidente+'E':'')+(x.recurrente?' RECURRENTE':'');})):'')
            +blk('#FEF3C7','#F59E0B','Muestras rechazadas',mR.slice(0,5).map(function(x){return '<b>'+(x.prod||'')+'</b> '+(x.cliente||'')+': '+(x.motivo||'Sin motivo');}))
            +blk('#F0FDF4','#22C55E','Muestras aprobadas',mOk.slice(0,5).map(function(x){return '<b>'+(x.prod||'')+'</b> '+(x.cliente||'');}))
            +footer+'</div>';
        }
        // ── I+D ──
        else if (rol==='tipologia' && (vendor==='I+D'||vendor==='ID'||pu.id.indexOf('resp_id')>=0)) {
          var mR2=muAll.filter(function(x){return x.estado==='ko'&&!x.eliminada;});
          var mO2=muAll.filter(function(x){return (x.estado==='positivo'||x.estado==='pedido')&&!x.eliminada;});
          var mPe=muAll.filter(function(x){return x.estado==='pendiente'&&!x.eliminada;});
          var pF=pryAll.filter(function(x){return (x.estado==='cerrado_perdido'||x.estado==='cerrado_sin_exito')&&!x.eliminada;});
          var pA=pryAll.filter(function(x){return x.estado==='activo'&&!x.eliminada;});
          if(mR2.length===0&&mO2.length===0&&pA.length===0) continue;
          subject='I+D: '+mR2.length+' rechazadas, '+mO2.length+' OK, '+pA.length+' proyectos';
          body=hdr('#2563EB','Informe I+D',hoyStr)
            +'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'
            +'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(mO2.length,'Aprobadas','#22C55E')+kpi(mR2.length,'Rechazadas','#EF4444')+kpi(mPe.length,'Pendientes','#F59E0B')+kpi(pA.length,'Proyectos','#3B82F6')+'</tr></table>'
            +blk('#FEE2E2','#EF4444','Rechazadas - por que?',mR2.slice(0,6).map(function(x){return '<b>'+(x.prod||'')+'</b> ('+(x.cliente||'')+'): '+(x.motivo||'Sin motivo')+' "'+(x.nota||'').substring(0,60)+'"';}))
            +blk('#F0FDF4','#22C55E','Con exito - que funciona?',mO2.slice(0,5).map(function(x){return '<b>'+(x.prod||'')+'</b> '+(x.cliente||'')+': '+(x.motivo||'OK');}))
            +(pF.length>0?blk('#FEF2F2','#DC2626','Proyectos sin exito',pF.slice(0,3).map(function(x){return '<b>'+(x.nombre||'')+'</b>: '+(x.motivoCierre||'Sin motivo');})):'')
            +blk('#EFF6FF','#3B82F6','Proyectos activos',pA.slice(0,5).map(function(x){return '<b>'+(x.nombre||'')+'</b> '+(x.progreso||0)+'%';}))
            +footer+'</div>';
        }
        // ── LOGISTICA ──
        else if (rol==='tipologia' && (vendor==='LOGISTICA'||pu.id.indexOf('log')>=0)) {
          var iL=incAll.filter(function(x){return !x.eliminada&&(x.tipo==='logistica'||x.tipo==='Logistica')&&x.estado!=='cerrada';});
          var iS=incAll.filter(function(x){return !x.eliminada&&(x.tipo==='stock'||x.tipo==='Stock')&&x.estado!=='cerrada';});
          if(iL.length===0&&iS.length===0) continue;
          subject='Logistica: '+iL.length+' incidencias, '+iS.length+' stock';
          body=hdr('#0EA5E9','Informe Logistica',hoyStr)
            +'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'
            +'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(iL.length,'Incidencias','#EF4444')+kpi(iS.length,'Stock','#F59E0B')+'</tr></table>'
            +blk('#FEE2E2','#EF4444','Incidencias logistica',iL.slice(0,5).map(function(x){return '<b>'+(x.clienteNombre||'')+'</b>: '+(x.descripcion||x.titulo||'').substring(0,80);}))
            +blk('#FEF3C7','#F59E0B','Alertas stock',iS.slice(0,5).map(function(x){return '<b>'+(x.clienteNombre||'')+'</b>: '+(x.descripcion||x.titulo||'').substring(0,80);}))
            +footer+'</div>';
        }
        // ── PRODUCCION ──
        else if (rol==='tipologia' && (vendor==='PRODUCCION'||pu.id.indexOf('prod')>=0)) {
          var iP=incAll.filter(function(x){return !x.eliminada&&(x.tipo==='produccion'||x.tipo==='Produccion')&&x.estado!=='cerrada';});
          var pI=pryAll.filter(function(x){return x.estado==='activo'&&!x.eliminada;});
          if(iP.length===0&&pI.length===0) continue;
          subject='Produccion: '+iP.length+' incidencias, '+pI.length+' proyectos';
          body=hdr('#D97706','Informe Produccion',hoyStr)
            +'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'
            +'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(iP.length,'Incidencias','#EF4444')+kpi(pI.length,'Proyectos','#3B82F6')+'</tr></table>'
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
          html: '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden">'+body+'</div>',
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
  } catch(err) {
    console.error('[SUMMARY] CRASH:', err);
    return res.status(200).json({error:err.message, stack:err.stack});
  }
};
