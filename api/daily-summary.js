// Vercel Cron — Resumen diario diferenciado por rol
// Lunes-Viernes 7:00 AM España (5:00 UTC)
// vercel.json: "crons": [{"path":"/api/daily-summary","schedule":"0 5 * * 1-5"}]

const nodemailer = require('nodemailer');
const FB_BASE = 'https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.office365.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  tls: { ciphers: 'SSLv3', rejectUnauthorized: false },
});

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
    let docs=[], next=null, i=0;
    do {
      const r = await fetch(`${FB_BASE}/${col}?pageSize=300${next?'&pageToken='+next:''}`);
      const d = await r.json();
      if (d.documents) docs.push(...d.documents.map(doc => {
        const obj={id:doc.name.split('/').pop()};
        Object.entries(doc.fields||{}).forEach(([k,v])=>{const val=pv(v);if(val!==undefined)obj[k]=val;});
        return obj;
      }));
      next=d.nextPageToken||null; i++;
    } while(next && i<10);
    return docs;
  } catch(e) { return []; }
}

const fmt = n => new Intl.NumberFormat('es-ES').format(n);
const hdr = (bg,title,sub) => `<div style="background:${bg};color:#fff;padding:20px 24px;border-radius:14px 14px 0 0"><h2 style="margin:0 0 4px;font-size:18px">${title}</h2><p style="margin:0;font-size:13px;opacity:.7">${sub}</p></div>`;
const blk = (bg,border,title,items) => items.length===0?'':`<div style="margin-bottom:16px;padding:12px 16px;background:${bg};border-radius:10px;border-left:4px solid ${border}"><p style="margin:0 0 6px;font-size:13px;font-weight:700;color:${border}">${title}</p>${items.map(t=>`<p style="margin:2px 0;font-size:12px;color:#475569">· ${t}</p>`).join('')}</div>`;
const kpi = (val,label,color) => `<td style="background:${color}15;border-radius:10px;padding:12px;text-align:center"><p style="margin:0;font-size:20px;font-weight:800;color:${color}">${val}</p><p style="margin:2px 0 0;font-size:10px;color:#64748B">${label}</p></td>`;

module.exports = async function handler(req, res) {
  if (!process.env.SMTP_USER) return res.status(503).json({error:'SMTP not configured'});
  const hoy = new Date();
  const hoyStr = hoy.toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const sem = Math.ceil(((hoy-new Date(hoy.getFullYear(),0,1))/86400000+new Date(hoy.getFullYear(),0,1).getDay()+1)/7);

  try {
    const [portal, tareas, inc, est, ops, muestras, act, proyectos] = await Promise.all([
      fb('portal_users'), fb('tareas'), fb('incidencias'),
      fb('estrategias'), fb('oportunidades'), fb('muestras'),
      fb('actividadSemanal'), fb('proyectos'),
    ]);

    // Email map
    const users = {};
    portal.forEach(pu => {
      if (!pu.email) return;
      const v = (pu.catalogoVendedor||'').toUpperCase();
      const rol = pu.rol || 'crm_agente';
      users[pu.id] = { email:pu.email, nombre:pu.nombre, vendor:v, rol, equipo:pu.equipo };
    });

    let sent = 0;
    const footer = `<a href="https://crmwikuk.vercel.app" style="display:inline-block;padding:14px 28px;background:#1E3A5F;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px;margin-top:12px">Abrir CRM →</a><p style="margin:20px 0 0;font-size:10px;color:#94A3B8;text-align:center">CRM Grupo Consolidado · Resumen automático</p>`;

    for (const [uid, u] of Object.entries(users)) {
      const r = u.rol;
      let subject='', body='';

      // ═══════════════════════════════════════
      // COMERCIAL (agente)
      // ═══════════════════════════════════════
      if (r==='crm_agente' || r==='agente') {
        const v = u.vendor;
        if (!v) continue;
        const myT = tareas.filter(t=>!t.eliminada&&t.estado!=='hecha'&&((t.agente||'').toUpperCase()===v||(t.agenteId||'').toUpperCase()===v));
        const myI = inc.filter(i=>!i.eliminada&&i.estado!=='cerrada'&&i.estado!=='resuelta'&&((i.agente||'').toUpperCase()===v||(i.autor||'').toUpperCase()===v));
        const myE = est.filter(e=>!e.eliminada&&e.estado==='en_curso'&&!e.resolucion&&(e.agente||'').toUpperCase()===v);
        const myO = ops.filter(o=>!o.eliminada&&!['ganada','perdida','cerrada_ganada','cerrada_perdida'].includes(o.estado||o.etapa)&&((o.agente||'').toUpperCase()===v||(o.agenteId||'').toUpperCase()===v));
        const myM = muestras.filter(m=>!m.eliminada&&m.estado==='pendiente'&&(m.agente||'').toUpperCase()===v);
        const myA = act.filter(a=>(a.agente||'').toUpperCase()===v&&parseInt(a.semana)===sem);
        const vis=myA.reduce((s,a)=>s+(parseInt(a.visitas)||0),0);
        const ped=myA.reduce((s,a)=>s+(parseInt(a.pedidos)||0),0);
        const pipe=myO.reduce((s,o)=>s+(parseInt(o.valor)||0),0);
        const total=myT.length+myI.length+myE.length+myO.length+myM.length;
        if(total===0&&vis===0) continue;

        subject = `📋 CRM ${hoyStr}: ${myT.length} tareas · ${myI.length} inc · ${myO.length} ops`;
        body = hdr('#1E3A5F',`📋 Buenos días, ${u.nombre}`,`${hoyStr} · Semana ${sem}`)
          + `<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">`
          + (vis>0?`<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>${kpi(vis,'Visitas','#3B82F6')}${kpi(ped,'Pedidos','#F59E0B')}${kpi(fmt(pipe)+'€','Pipeline','#1E3A5F')}</tr></table>`:'')
          + blk('#FEF3C7','#F59E0B',`📌 ${myT.length} tareas pendientes`,myT.slice(0,4).map(t=>(t.titulo||t.texto||'')+(t.vence?' <span style="color:#DC2626">📅 '+t.vence+'</span>':'')))
          + blk('#FEE2E2','#EF4444',`🚨 ${myI.length} incidencias`,myI.slice(0,3).map(i=>(i.titulo||i.tipo||'')+(i.clienteNombre?' — '+i.clienteNombre:'')))
          + blk('#DBEAFE','#3B82F6',`🎯 ${myE.length} estrategias activas`,myE.slice(0,3).map(e=>(e.cliente||'')+' — '+(e.texto||e.objetivo||'').substring(0,60)))
          + blk('#F5F3FF','#7C3AED',`📦 ${myM.length} muestras pendientes`,myM.slice(0,3).map(m=>(m.prod||'')+' — '+(m.cliente||'')))
          + footer + '</div>';
      }

      // ═══════════════════════════════════════
      // DIRECTOR / CEO — Panel ejecutivo
      // ═══════════════════════════════════════
      else if (r==='crm_director'||r==='director'||r==='ceo') {
        const allOps = ops.filter(o=>!o.eliminada);
        const opsAct = allOps.filter(o=>!['ganada','perdida','cerrada_ganada','cerrada_perdida'].includes(o.estado||o.etapa));
        const opsGan = allOps.filter(o=>o.estado==='ganada'||o.etapa==='cerrada_ganada');
        const opsPer = allOps.filter(o=>o.estado==='perdida'||o.etapa==='cerrada_perdida');
        const sinAsignar = opsAct.filter(o=>o.estado==='sin_asignar'||!o.agenteId);
        const pipe = opsAct.reduce((s,o)=>s+(parseInt(o.valor)||0),0);
        const incAbi = inc.filter(i=>!i.eliminada&&i.estado!=='cerrada'&&i.estado!=='resuelta');
        const estAct = est.filter(e=>!e.eliminada&&e.estado==='en_curso'&&!e.resolucion);
        const mSinResp = muestras.filter(m=>!m.eliminada&&m.estado==='pendiente');
        const pryAct = proyectos.filter(p=>p.estado==='activo'&&!p.eliminada);
        const visTotal = act.filter(a=>parseInt(a.semana)===sem).reduce((s,a)=>s+(parseInt(a.visitas)||0),0);
        const pedTotal = act.filter(a=>parseInt(a.semana)===sem).reduce((s,a)=>s+(parseInt(a.pedidos)||0),0);

        // Actividad por vendedor
        const vendedores = {};
        act.filter(a=>parseInt(a.semana)===sem).forEach(a=>{
          const v=(a.agente||'').toUpperCase();if(!v)return;
          if(!vendedores[v]) vendedores[v]={vis:0,ped:0,notas:[]};
          vendedores[v].vis+=(parseInt(a.visitas)||0);
          vendedores[v].ped+=(parseInt(a.pedidos)||0);
          if(a.comentario) vendedores[v].notas.push(a.comentario);
          if(a.nota) vendedores[v].notas.push(a.nota);
        });
        const vendRows = Object.entries(vendedores).map(([v,d])=>{
          const pu2=portal.find(p=>(p.catalogoVendedor||'').toUpperCase()===v);
          return `<tr style="border-bottom:1px solid #E2E8F0"><td style="padding:3px 0;font-weight:600">${pu2?.nombre||v}</td><td style="text-align:right">${d.vis} vis</td><td style="text-align:right">${d.ped} ped</td></tr>`;
        }).join('');
        const notasTop = Object.entries(vendedores).flatMap(([v,d])=>{
          const pu2=portal.find(p=>(p.catalogoVendedor||'').toUpperCase()===v);
          return d.notas.slice(0,1).map(n=>`<b>${pu2?.nombre||v}:</b> <i>"${n.substring(0,100)}"</i>`);
        });

        subject = `📊 Panel ejecutivo: ${fmt(pipe)}€ pipeline · ${incAbi.length} inc · ${visTotal} visitas`;
        body = hdr('linear-gradient(135deg,#1E3A5F,#0F172A)','📊 Panel ejecutivo',hoyStr+' · Semana '+sem)
          + `<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">`
          + `<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>${kpi(visTotal,'Visitas','#3B82F6')}${kpi(pedTotal,'Pedidos','#F59E0B')}${kpi(fmt(pipe)+'€','Pipeline','#1E3A5F')}${kpi(estAct.length,'Estrategias','#7C3AED')}</tr></table>`
          + `<div style="margin-bottom:16px;padding:12px 16px;background:#F8FAFC;border-radius:10px"><p style="margin:0 0 8px;font-size:13px;font-weight:700">👥 Actividad por vendedor</p><table width="100%" style="font-size:11px;color:#475569;border-collapse:collapse">${vendRows}</table></div>`
          + (incAbi.length>0||sinAsignar.length>0||mSinResp.length>0?`<p style="margin:0 0 10px;font-size:14px;font-weight:700;color:#DC2626">⚠️ Requiere atención</p>`:'')
          + blk('#FEE2E2','#EF4444',`🚨 ${incAbi.length} incidencias abiertas`,incAbi.slice(0,4).map(i=>(i.tipo||'')+': '+(i.titulo||i.asunto||'')+(i.clienteNombre?' — '+i.clienteNombre:'')))
          + (sinAsignar.length>0?blk('#FEF3C7','#F59E0B',`⏳ ${sinAsignar.length} oportunidades sin asignar`,sinAsignar.slice(0,3).map(o=>o.cliente||o.nombre||'')):'')
          + blk('#F5F3FF','#7C3AED',`📦 ${mSinResp.length} muestras sin respuesta`,mSinResp.slice(0,3).map(m=>(m.prod||'')+' — '+(m.cliente||'')))
          + blk('#DBEAFE','#3B82F6',`🎯 ${estAct.length} estrategias activas`,estAct.slice(0,4).map(e=>(e.cliente||'')+' — '+(e.texto||'').substring(0,50)+' <span style="color:#94A3B8">('+((portal.find(p=>(p.catalogoVendedor||'')===(e.agente||'')))||{}).nombre||e.agente||'')+')</span>'))
          + (pryAct.length>0?blk('#F8FAFC','#64748B',`📁 ${pryAct.length} proyectos activos`,pryAct.slice(0,3).map(p=>(p.nombre||'')+' — '+((p.progreso||0))+'% completado')):'')
          + (opsGan.length>0?blk('#F0FDF4','#22C55E',`🎉 ${opsGan.length} ops ganadas`,opsGan.slice(0,3).map(o=>(o.cliente||'')+' — '+(o.valor?fmt(o.valor)+'€':''))):'')
          + (notasTop.length>0?`<div style="margin-bottom:16px;padding:12px 16px;background:#FFFBEB;border-radius:10px;border-left:4px solid #F59E0B"><p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#92400E">💬 Notas destacadas</p>${notasTop.map(n=>`<p style="margin:4px 0;font-size:12px;color:#78350F">${n}</p>`).join('')}</div>`:'')
          + footer + '</div>';
      }

      // ═══════════════════════════════════════
      // CALIDAD
      // ═══════════════════════════════════════
      else if (r==='tipologia' && (u.vendor==='CALIDAD'||uid.includes('cal'))) {
        const myInc = inc.filter(i=>!i.eliminada&&(i.tipo==='calidad'||i.tipo==='Calidad')&&i.estado!=='cerrada'&&i.estado!=='resuelta');
        const mRech = muestras.filter(m=>m.estado==='ko'&&!m.eliminada);
        const mOk = muestras.filter(m=>(m.estado==='positivo'||m.estado==='pedido')&&!m.eliminada);
        if(myInc.length===0&&mRech.length===0) continue;

        subject = `🔬 Calidad: ${myInc.length} incidencias · ${mRech.length} muestras rechazadas`;
        body = hdr('#7C3AED','🔬 Informe de Calidad',hoyStr)
          + `<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">`
          + `<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>${kpi(myInc.length,'Inc. abiertas','#EF4444')}${kpi(mRech.length,'Rechazadas','#F59E0B')}${kpi(mOk.length,'Aprobadas','#22C55E')}</tr></table>`
          + blk('#FEE2E2','#EF4444','🚨 Incidencias de calidad abiertas',myInc.map(i=>`<b>${i.clienteNombre||i.cliente||''}</b>: ${i.descripcion||i.titulo||''} <span style="color:#94A3B8">(${i.fecha||''})</span>`))
          + blk('#FEF3C7','#F59E0B','❌ Muestras rechazadas — análisis para mejora',mRech.slice(0,5).map(m=>`<b>${m.prod||''}</b> → ${m.cliente||''}: ${(m.nota||m.comentario||'Sin motivo registrado').substring(0,80)}`))
          + blk('#F0FDF4','#22C55E','✅ Muestras aprobadas (últimas)',mOk.slice(0,5).map(m=>`<b>${m.prod||''}</b> → ${m.cliente||''}`))
          + footer + '</div>';
      }

      // ═══════════════════════════════════════
      // LOGÍSTICA
      // ═══════════════════════════════════════
      else if (r==='tipologia' && (u.vendor==='LOGISTICA'||uid.includes('log'))) {
        const myInc = inc.filter(i=>!i.eliminada&&(i.tipo==='logistica'||i.tipo==='Logística')&&i.estado!=='cerrada'&&i.estado!=='resuelta');
        const stk = inc.filter(i=>!i.eliminada&&(i.tipo==='stock'||i.tipo==='Stock')&&i.estado!=='cerrada');
        if(myInc.length===0&&stk.length===0) continue;

        subject = `🚚 Logística: ${myInc.length} incidencias · ${stk.length} alertas stock`;
        body = hdr('#0EA5E9','🚚 Informe de Logística',hoyStr)
          + `<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">`
          + `<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>${kpi(myInc.length,'Inc. logística','#EF4444')}${kpi(stk.length,'Alertas stock','#F59E0B')}</tr></table>`
          + blk('#FEE2E2','#EF4444','🚨 Incidencias de logística',myInc.map(i=>`<b>${i.clienteNombre||''}</b>: ${i.descripcion||i.titulo||''}`))
          + blk('#FEF3C7','#F59E0B','📦 Alertas de stock',stk.map(i=>`<b>${i.clienteNombre||''}</b>: ${i.descripcion||i.titulo||''}`))
          + footer + '</div>';
      }

      // ═══════════════════════════════════════
      // I+D — Muestras + Proyectos + Oportunidades mercado
      // ═══════════════════════════════════════
      else if (r==='tipologia' && (u.vendor==='I+D'||u.vendor==='ID'||uid.includes('id')||uid.includes('prd'))) {
        const mRech = muestras.filter(m=>m.estado==='ko'&&!m.eliminada);
        const mOk = muestras.filter(m=>(m.estado==='positivo'||m.estado==='pedido'||m.estado==='proyecto')&&!m.eliminada);
        const mPend = muestras.filter(m=>m.estado==='pendiente'&&!m.eliminada);
        const pryFail = proyectos.filter(p=>p.estado==='cerrado_sin_exito'&&!p.eliminada);
        const pryOk = proyectos.filter(p=>p.estado==='cerrado'&&!p.eliminada);
        const pryAct = proyectos.filter(p=>p.estado==='activo'&&!p.eliminada);
        // Oportunidades de mercado = notas de comerciales que mencionan productos nuevos
        const opsNuevas = ops.filter(o=>!o.eliminada&&(o.tipoOpo==='nuevo'||o.tipoOpo==='expansion')&&!['ganada','perdida','cerrada_ganada','cerrada_perdida'].includes(o.estado||o.etapa));

        subject = `⚗️ I+D: ${mRech.length} rechazadas · ${mOk.length} OK · ${pryAct.length} proyectos activos`;
        body = hdr('#2563EB','⚗️ Informe I+D — Investigación y Desarrollo',hoyStr)
          + `<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">`
          + `<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>${kpi(mOk.length,'Aprobadas','#22C55E')}${kpi(mRech.length,'Rechazadas','#EF4444')}${kpi(mPend.length,'Pendientes','#F59E0B')}${kpi(pryAct.length,'Proyectos','#3B82F6')}</tr></table>`
          + blk('#FEE2E2','#EF4444','❌ Muestras rechazadas — ¿por qué? → oportunidad de mejora',mRech.slice(0,8).map(m=>`<b>${m.prod||''}</b> (${m.cliente||''}): ${(m.nota||m.comentario||'Motivo no registrado').substring(0,100)}`))
          + blk('#F0FDF4','#22C55E','✅ Muestras con éxito — ¿qué funciona?',mOk.slice(0,5).map(m=>`<b>${m.prod||''}</b> → ${m.cliente||''}: ${(m.nota||'Aprobada').substring(0,80)}`))
          + (pryFail.length>0?blk('#FEF2F2','#DC2626','📁 Proyectos sin éxito — lecciones aprendidas',pryFail.slice(0,3).map(p=>`<b>${p.nombre||''}</b>: ${(p.motivoCierre||p.nota||'Sin motivo registrado').substring(0,80)}`)):'')
          + (pryOk.length>0?blk('#F0FDF4','#16A34A','📁 Proyectos completados con éxito',pryOk.slice(0,3).map(p=>`<b>${p.nombre||''}</b>: ${(p.nota||'Completado').substring(0,60)}`)):'')
          + blk('#EFF6FF','#3B82F6','📁 Proyectos activos en curso',pryAct.slice(0,5).map(p=>`<b>${p.nombre||''}</b> — ${p.progreso||0}% completado`))
          + blk('#FFFBEB','#D97706','🔍 Oportunidades de mercado (nuevos clientes/expansión)',opsNuevas.slice(0,5).map(o=>`<b>${o.cliente||''}</b>: ${(o.notas||o.descripcion||'').toString().substring(0,80)} <span style="color:#94A3B8">(${(portal.find(p=>(p.catalogoVendedor||'')===(o.agente||'')))||{}).nombre||o.agente||''})</span>`))
          + footer + '</div>';
      }

      // ═══════════════════════════════════════
      // PRODUCCIÓN
      // ═══════════════════════════════════════
      else if (r==='tipologia' && (u.vendor==='PRODUCCION'||uid.includes('prd')||uid.includes('prod'))) {
        const myInc = inc.filter(i=>!i.eliminada&&(i.tipo==='produccion'||i.tipo==='Producción')&&i.estado!=='cerrada');
        const pryAct = proyectos.filter(p=>p.estado==='activo'&&!p.eliminada&&(p.tipo==='industrial'||p.tipo==='lanzamiento'));
        const hitosProx = [];
        pryAct.forEach(p=>{
          (p.hitos||[]).forEach(h=>{
            if(!h.hecho&&(h.responsable==='produccion'||h.responsable==='industrial')) hitosProx.push({proy:p.nombre,...h});
          });
        });
        if(myInc.length===0&&pryAct.length===0&&hitosProx.length===0) continue;

        subject = `🏭 Producción: ${myInc.length} incidencias · ${pryAct.length} proyectos · ${hitosProx.length} hitos`;
        body = hdr('#D97706','🏭 Informe de Producción',hoyStr)
          + `<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">`
          + `<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>${kpi(myInc.length,'Incidencias','#EF4444')}${kpi(pryAct.length,'Proyectos','#3B82F6')}${kpi(hitosProx.length,'Hitos pend.','#F59E0B')}</tr></table>`
          + blk('#FEE2E2','#EF4444','🚨 Incidencias de producción',myInc.map(i=>`<b>${i.clienteNombre||''}</b>: ${i.descripcion||i.titulo||''}`))
          + blk('#EFF6FF','#3B82F6','📁 Proyectos industriales activos',pryAct.map(p=>`<b>${p.nombre||''}</b> — ${p.progreso||0}%`))
          + blk('#FEF3C7','#F59E0B','📍 Hitos pendientes de producción',hitosProx.map(h=>`<b>${h.proy}</b>: ${h.nombre}${h.fecha?' 📅 '+h.fecha:''}`))
          + footer + '</div>';
      }

      // ═══════════════════════════════════════
      // JEFE DE EQUIPO
      // ═══════════════════════════════════════
      else if (r==='crm_jefe'||r==='jefe') {
        const eq = u.equipo;
        if(!eq) continue;
        const eqVendors = portal.filter(p=>p.equipo===eq&&(p.rol==='crm_agente'||p.rol==='agente')).map(p=>(p.catalogoVendedor||'').toUpperCase()).filter(Boolean);
        const myT = tareas.filter(t=>!t.eliminada&&t.estado!=='hecha'&&eqVendors.includes((t.agente||'').toUpperCase()));
        const myI = inc.filter(i=>!i.eliminada&&i.estado!=='cerrada'&&i.estado!=='resuelta'&&i.equipo===eq);
        const myE = est.filter(e=>!e.eliminada&&e.estado==='en_curso'&&!e.resolucion&&eqVendors.includes((e.agente||'').toUpperCase()));
        const myO = ops.filter(o=>!o.eliminada&&!['ganada','perdida','cerrada_ganada','cerrada_perdida'].includes(o.estado||o.etapa)&&eqVendors.includes((o.agente||o.agenteId||'').toUpperCase()));
        const pipe=myO.reduce((s,o)=>s+(parseInt(o.valor)||0),0);
        const vendRows = eqVendors.map(v=>{
          const a=act.filter(x=>(x.agente||'').toUpperCase()===v&&parseInt(x.semana)===sem);
          const vis=a.reduce((s,x)=>s+(parseInt(x.visitas)||0),0);
          const ped=a.reduce((s,x)=>s+(parseInt(x.pedidos)||0),0);
          const nm=(portal.find(p=>(p.catalogoVendedor||'').toUpperCase()===v)||{}).nombre||v;
          return `<tr style="border-bottom:1px solid #E2E8F0"><td style="padding:3px 0;font-weight:600">${nm}</td><td style="text-align:right">${vis} vis</td><td style="text-align:right">${ped} ped</td></tr>`;
        }).join('');

        subject = `👥 Equipo ${eq}: ${myT.length} tareas · ${myI.length} inc · ${fmt(pipe)}€ pipeline`;
        body = hdr(eq==='WIKUK'?'#166534':'#92400E',`👥 Equipo ${eq}`,hoyStr+' · Semana '+sem)
          + `<div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">`
          + `<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>${kpi(myT.length,'Tareas','#F59E0B')}${kpi(myI.length,'Incidencias','#EF4444')}${kpi(fmt(pipe)+'€','Pipeline','#1E3A5F')}</tr></table>`
          + `<div style="margin-bottom:16px;padding:12px 16px;background:#F8FAFC;border-radius:10px"><p style="margin:0 0 8px;font-size:13px;font-weight:700">📊 Actividad semanal</p><table width="100%" style="font-size:11px;color:#475569;border-collapse:collapse">${vendRows}</table></div>`
          + blk('#FEF3C7','#F59E0B',`📌 Tareas pendientes del equipo`,myT.slice(0,5).map(t=>(t.titulo||'')+' <span style="color:#94A3B8">('+((portal.find(p=>(p.catalogoVendedor||'')===(t.agente||'')))||{}).nombre||t.agente||'')+')</span>'))
          + blk('#FEE2E2','#EF4444',`🚨 Incidencias`,myI.slice(0,3).map(i=>(i.titulo||i.tipo||'')+(i.clienteNombre?' — '+i.clienteNombre:'')))
          + blk('#DBEAFE','#3B82F6',`🎯 Estrategias`,myE.slice(0,3).map(e=>(e.cliente||'')+' — '+(e.texto||'').substring(0,50)))
          + footer + '</div>';
      }

      else continue;

      // Send
      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: u.email, subject, html: `<div style="font-family:'Segoe UI',sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">${body}</div>`,
        });
        sent++;
        console.log(`[SUMMARY] ✉️ ${u.rol} → ${u.email} (${u.nombre})`);
      } catch(e) { console.error(`[SUMMARY] ❌ ${u.email}:`,e.message); }
    }

    console.log(`[SUMMARY] Done: ${sent} emails`);
    return res.status(200).json({ok:true,sent,users:Object.keys(users).length});
  } catch(error) {
    console.error('[SUMMARY]',error);
    return res.status(500).json({error:error.message});
  }
};
