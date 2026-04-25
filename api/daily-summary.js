// Vercel Cron — Resumen diario diferenciado por rol
// Lunes-Viernes 7:00 AM España (5:00 UTC)
const nodemailer = require('nodemailer');
const https = require('https');

const FB_BASE = 'https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({}); } });
    }).on('error', reject);
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
  if (v.mapValue) { const o={}; Object.entries(v.mapValue.fields||{}).forEach(([k,val])=>{o[k]=pv(val);}); return o; }
  return undefined;
}

async function fb(col) {
  try {
    const d = await httpGet(FB_BASE + '/' + col + '?pageSize=500');
    if (!d.documents) return [];
    return d.documents.map(doc => {
      const obj = { id: doc.name.split('/').pop() };
      Object.entries(doc.fields || {}).forEach(([k, v]) => { const val = pv(v); if (val !== undefined) obj[k] = val; });
      return obj;
    });
  } catch(e) { console.error('[FB]', col, e.message); return []; }
}

const fmt = n => new Intl.NumberFormat('es-ES').format(n);
const hdr = (bg,title,sub) => '<div style="background:'+bg+';color:#fff;padding:20px 24px;border-radius:14px 14px 0 0"><h2 style="margin:0 0 4px;font-size:18px">'+title+'</h2><p style="margin:0;font-size:13px;opacity:.7">'+sub+'</p></div>';
const blk = (bg,border,title,items) => items.length===0?'':'<div style="margin-bottom:16px;padding:12px 16px;background:'+bg+';border-radius:10px;border-left:4px solid '+border+'"><p style="margin:0 0 6px;font-size:13px;font-weight:700;color:'+border+'">'+title+'</p>'+items.map(t=>'<p style="margin:2px 0;font-size:12px;color:#475569">&middot; '+t+'</p>').join('')+'</div>';
const kpi = (val,label,color) => '<td style="background:'+color+'15;border-radius:10px;padding:12px;text-align:center"><p style="margin:0;font-size:20px;font-weight:800;color:'+color+'">'+val+'</p><p style="margin:2px 0 0;font-size:10px;color:#64748B">'+label+'</p></td>';

module.exports = async function handler(req, res) {
  if (!process.env.SMTP_USER) return res.status(503).json({error:'SMTP not configured'});

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls: { rejectUnauthorized: false },
  });

  const hoy = new Date();
  const hoyStr = hoy.toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const sem = Math.ceil(((hoy-new Date(hoy.getFullYear(),0,1))/86400000+new Date(hoy.getFullYear(),0,1).getDay()+1)/7);

  try {
    console.log('[SUMMARY] Loading data...');
    const [portal, tareas, inc, est, ops, muestras, proyectos] = await Promise.all([
      fb('portal_users'), fb('tareas'), fb('incidencias'),
      fb('estrategias'), fb('oportunidades'), fb('muestras'), fb('proyectos'),
    ]);
    console.log('[SUMMARY] Data loaded: portal='+portal.length+' tareas='+tareas.length+' inc='+inc.length+' est='+est.length+' ops='+ops.length);

    const users = {};
    portal.forEach(pu => {
      if (!pu.email) return;
      users[pu.id] = { email:pu.email, nombre:pu.nombre||pu.id, vendor:(pu.catalogoVendedor||'').toUpperCase(), rol:pu.rol||'crm_agente', equipo:pu.equipo };
    });
    console.log('[SUMMARY] Users with email: '+Object.keys(users).length);

    let sent = 0;
    const footer = '<a href="https://crmwikuk.vercel.app" style="display:inline-block;padding:14px 28px;background:#1E3A5F;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px;margin-top:12px">Abrir CRM</a><p style="margin:20px 0 0;font-size:10px;color:#94A3B8;text-align:center">CRM Grupo Consolidado</p>';

    for (const [uid, u] of Object.entries(users)) {
      let subject='', body='';

      // COMERCIAL
      if (u.rol==='crm_agente'||u.rol==='agente') {
        var v=u.vendor; if(!v) continue;
        var myT=tareas.filter(function(t){return !t.eliminada&&t.estado!=='hecha'&&((t.agente||'').toUpperCase()===v||(t.agenteId||'').toUpperCase()===v);});
        var myI=inc.filter(function(i){return !i.eliminada&&i.estado!=='cerrada'&&i.estado!=='resuelta'&&((i.agente||'').toUpperCase()===v||(i.autor||'').toUpperCase()===v);});
        var myE=est.filter(function(e){return !e.eliminada&&e.estado==='en_curso'&&!e.resolucion&&(e.agente||'').toUpperCase()===v;});
        var myO=ops.filter(function(o){return !o.eliminada&&!['ganada','perdida','cerrada_ganada','cerrada_perdida'].includes(o.estado||o.etapa)&&((o.agente||'').toUpperCase()===v||(o.agenteId||'').toUpperCase()===v);});
        var myM=muestras.filter(function(m){return !m.eliminada&&m.estado==='pendiente'&&(m.agente||'').toUpperCase()===v;});
        var pipe=myO.reduce(function(s,o){return s+(parseInt(o.valor)||0);},0);
        var total=myT.length+myI.length+myE.length+myO.length+myM.length;
        if(total===0) continue;
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
      // DIRECTOR / CEO
      else if (u.rol==='crm_director'||u.rol==='director'||u.rol==='ceo') {
        var opsAct=ops.filter(function(o){return !o.eliminada&&!['ganada','perdida','cerrada_ganada','cerrada_perdida'].includes(o.estado||o.etapa);});
        var incAbi=inc.filter(function(i){return !i.eliminada&&i.estado!=='cerrada'&&i.estado!=='resuelta';});
        var estAct=est.filter(function(e){return !e.eliminada&&e.estado==='en_curso'&&!e.resolucion;});
        var mPend=muestras.filter(function(m){return !m.eliminada&&m.estado==='pendiente';});
        var pipe2=opsAct.reduce(function(s,o){return s+(parseInt(o.valor)||0);},0);
        var pryAct=proyectos.filter(function(p){return p.estado==='activo'&&!p.eliminada;});
        subject='Panel ejecutivo: '+fmt(pipe2)+'E pipeline, '+incAbi.length+' inc, '+estAct.length+' estrategias';
        body=hdr('#1E3A5F','Panel ejecutivo',hoyStr+' - Semana '+sem)
          +'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'
          +'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(opsAct.length,'Ops activas','#3B82F6')+kpi(incAbi.length,'Incidencias','#EF4444')+kpi(fmt(pipe2)+'E','Pipeline','#1E3A5F')+kpi(estAct.length,'Estrategias','#7C3AED')+'</tr></table>'
          +blk('#FEE2E2','#EF4444','Incidencias abiertas ('+incAbi.length+')',incAbi.slice(0,4).map(function(i){return (i.tipo||'')+': '+(i.titulo||i.asunto||'')+(i.clienteNombre?' - '+i.clienteNombre:'');}))
          +blk('#DBEAFE','#3B82F6','Estrategias activas ('+estAct.length+')',estAct.slice(0,4).map(function(e){return (e.cliente||'')+' - '+(e.texto||'').substring(0,50);}))
          +blk('#F5F3FF','#7C3AED','Muestras sin respuesta ('+mPend.length+')',mPend.slice(0,3).map(function(m){return (m.prod||'')+' - '+(m.cliente||'');}))
          +(pryAct.length>0?blk('#F8FAFC','#64748B','Proyectos activos ('+pryAct.length+')',pryAct.slice(0,3).map(function(p){return (p.nombre||'')+' - '+(p.progreso||0)+'%';})):'')
          +footer+'</div>';
      }
      // JEFE EQUIPO
      else if (u.rol==='crm_jefe'||u.rol==='jefe') {
        var eq=u.equipo; if(!eq) continue;
        var eqV=portal.filter(function(p){return p.equipo===eq&&(p.rol==='crm_agente'||p.rol==='agente');}).map(function(p){return (p.catalogoVendedor||'').toUpperCase();}).filter(Boolean);
        var myT2=tareas.filter(function(t){return !t.eliminada&&t.estado!=='hecha'&&eqV.includes((t.agente||'').toUpperCase());});
        var myI2=inc.filter(function(i){return !i.eliminada&&i.estado!=='cerrada'&&i.estado!=='resuelta'&&i.equipo===eq;});
        var myE2=est.filter(function(e){return !e.eliminada&&e.estado==='en_curso'&&!e.resolucion&&eqV.includes((e.agente||'').toUpperCase());});
        var myO2=ops.filter(function(o){return !o.eliminada&&!['ganada','perdida','cerrada_ganada','cerrada_perdida'].includes(o.estado||o.etapa)&&eqV.includes((o.agente||o.agenteId||'').toUpperCase());});
        var pipe3=myO2.reduce(function(s,o){return s+(parseInt(o.valor)||0);},0);
        subject='Equipo '+eq+': '+myT2.length+' tareas, '+myI2.length+' inc, '+fmt(pipe3)+'E';
        body=hdr(eq==='WIKUK'?'#166534':'#92400E','Equipo '+eq,hoyStr+' - Semana '+sem)
          +'<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">'
          +'<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+kpi(myT2.length,'Tareas','#F59E0B')+kpi(myI2.length,'Incidencias','#EF4444')+kpi(fmt(pipe3)+'E','Pipeline','#1E3A5F')+'</tr></table>'
          +blk('#FEF3C7','#F59E0B','Tareas equipo',myT2.slice(0,5).map(function(t){return t.titulo||'';}))
          +blk('#FEE2E2','#EF4444','Incidencias',myI2.slice(0,3).map(function(i){return (i.titulo||i.tipo||'')+(i.clienteNombre?' - '+i.clienteNombre:'');}))
          +blk('#DBEAFE','#3B82F6','Estrategias',myE2.slice(0,3).map(function(e){return (e.cliente||'')+' - '+(e.texto||'').substring(0,50);}))
          +footer+'</div>';
      }
      else continue;

      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM||process.env.SMTP_USER,
          to: u.email, subject,
          html: '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden">'+body+'</div>',
        });
        sent++;
        console.log('[SUMMARY] Sent to '+u.email+' ('+u.nombre+')');
      } catch(e) { console.error('[SUMMARY] FAIL '+u.email+': '+e.message); }
    }

    console.log('[SUMMARY] Done: '+sent+' emails');
    return res.status(200).json({ok:true,sent:sent,users:Object.keys(users).length});
  } catch(error) {
    console.error('[SUMMARY] ERROR:',error);
    return res.status(500).json({error:error.message||'Unknown error'});
  }
};
