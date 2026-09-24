// api/aviso-retrasos.js
// Dos avisos sobre los retrasos de pedido, con el mismo cálculo que el CRM:
//
//   ?tipo=diario   → corto, solo si hay pedidos SIN MOTIVO. Dinero retenido,
//                    días que lleva cada uno sin clasificar y quién lo clasifica.
//                    Si está todo clasificado NO se envía nada: recibirlo ya es
//                    el aviso, y no recibirlo es la recompensa.
//   ?tipo=semanal  → completo. Motivos y medias de los últimos 60 días, más los
//                    de la semana sin clasificar y su efecto económico.
//
// Un retraso = un pedido movido 3 días o más. Si se mueve tres veces sigue
// siendo uno, contando el desplazamiento mayor.
//
// Se puede probar sin enviar: &probar=1 devuelve el HTML y los destinatarios.

const FB = "https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents";
const DIAS_HIST = 60;
const MIN_DIAS  = 3;            // menos de 3 días no se considera retraso
const DESDE     = "2026-09-08"; // arranque limpio: antes no se exigía clasificar
const CRM       = "https://crmwikuk.vercel.app";

// Quién recibe cada aviso: Operaciones y lo que cuelga de ella, más dirección
const RAIZ_DEPTOS = ["operaciones"];
const SIEMPRE     = ["ceo", "dir"];
const GENERICOS   = ["info@unitedcaro.com"];

// Organigrama base (el de la base de datos manda sobre esto)
const DEPTOS_BASE = [
  {id:"direccion",   nombre:"Dirección",     padre:null,          responsableIds:["ceo"]},
  {id:"operaciones", nombre:"Operaciones",   padre:"direccion",   responsableIds:[]},
  {id:"produccion",  nombre:"Producción",    padre:"operaciones", responsableIds:["resp_prd"]},
  {id:"coordinacion",nombre:"Coordinación",  padre:"operaciones", responsableIds:["resp_coord"]},
  {id:"compras",     nombre:"Compras",       padre:"direccion",   responsableIds:[]},
  {id:"logistica",   nombre:"Logística",     padre:"compras",     responsableIds:["resp_log"]},
];

// ── Firestore ────────────────────────────────────────────────────────
function val(f){
  if(!f) return null;
  if(f.stringValue!==undefined) return f.stringValue;
  if(f.integerValue!==undefined) return parseInt(f.integerValue);
  if(f.doubleValue!==undefined) return Number(f.doubleValue);
  if(f.booleanValue!==undefined) return f.booleanValue;
  if(f.arrayValue!==undefined) return (f.arrayValue.values||[]).map(val);
  return null;
}
function obj(doc){
  if(!doc||!doc.fields) return null;
  const o={_id:decodeURIComponent((doc.name||"").split("/").pop())};
  for(const k in doc.fields) o[k]=val(doc.fields[k]);
  return o;
}
async function leerDoc(ruta){
  const r=await fetch(`${FB}/${ruta}`);
  return r.ok ? obj(await r.json()) : null;
}
async function leerCol(col){
  const out=[]; let tok=null, v=0;
  do{
    const r=await fetch(`${FB}/${col}?pageSize=300`+(tok?"&pageToken="+encodeURIComponent(tok):""));
    if(!r.ok) break;
    const j=await r.json();
    (j.documents||[]).forEach(d=>{ const o=obj(d); if(o) out.push(o); });
    tok=j.nextPageToken||null; v++;
  }while(tok&&v<20);
  return out;
}
async function guardarDoc(ruta,campos){
  const f={};
  for(const k in campos){
    const v=campos[k];
    f[k] = typeof v==="number" ? {doubleValue:v} : {stringValue:String(v==null?"":v)};
  }
  await fetch(`${FB}/${ruta}`,{method:"PATCH",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({fields:f})}).catch(()=>{});
}

// ── Utilidades ───────────────────────────────────────────────────────
const iso=d=>d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
const eur=n=>Math.round(Number(n)||0).toLocaleString("es-ES")+" €";
const d1 =n=>(Math.round((Number(n)||0)*10)/10).toLocaleString("es-ES").replace(".",",");
const esc=t=>String(t==null?"":t).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const clave=m=>[m.pedido||"",m.articulo||m.descripcion||"",m.cliente||m.nombre||""]
  .join("|").replace(/[\s\/]/g,"_").slice(0,180);
const diasEntre=(a,b)=>Math.round((new Date(b+"T12:00:00")-new Date(a+"T12:00:00"))/86400000);
function fLarga(f){
  const d=new Date(f+"T12:00:00");
  const M=["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  const D=["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
  return D[d.getDay()]+", "+d.getDate()+" de "+M[d.getMonth()];
}

// ── Los retrasos, tal como los cuenta el CRM ─────────────────────────
async function cargarRetrasos(hoy){
  const fechas=[];
  for(let i=0;i<DIAS_HIST;i++){ const d=new Date(hoy); d.setDate(d.getDate()-i); fechas.push(iso(d)); }

  const docs=[];
  for(let i=0;i<fechas.length;i+=12){
    const t=await Promise.all(fechas.slice(i,i+12).map(f=>
      fetch(`${FB}/pbi_pedidos_cambios/${f}`).then(r=>r.ok?r.json():null).catch(()=>null)));
    t.forEach((d,j)=>{ if(d) docs.push({fecha:fechas[i+j],doc:d}); });
  }

  const motivos={};
  (await leerCol("pbi_retrasos_motivo")).forEach(m=>{
    if(m.motivo) motivos[m._id]={motivo:m.motivo,nota:m.nota||"",por:m.por||m.quien||""};
  });

  const vistos={};
  docs.forEach(({fecha,doc})=>{
    const f=doc.fields||{};
    let movs=[];
    try{ movs=JSON.parse((f.movimientos&&f.movimientos.stringValue)||"[]"); }catch(e){}
    movs.filter(m=>m.tipo==="retraso"&&Math.abs(m.dias||0)>=MIN_DIAS).forEach(m=>{
      const k=clave(m);
      if(vistos[k]){
        vistos[k].dias=Math.max(vistos[k].dias,Math.abs(m.dias||0));
        if(fecha<vistos[k].desde) vistos[k].desde=fecha;   // la primera vez que se movió
        return;
      }
      vistos[k]={k, desde:fecha,
        imp:Number(m.importe)||0, dias:Math.abs(m.dias||0),
        pedido:m.pedido||"", cliente:m.nombre||m.cliente||"",
        agente:m.agente||m.vendedor||"", articulo:m.descripcion||m.articulo||"",
        motivo:(motivos[k]||{}).motivo||null, quien:(motivos[k]||{}).por||""};
    });
  });
  return Object.values(vistos).filter(x=>x.desde>=DESDE);
}

// ── Destinatarios ────────────────────────────────────────────────────
async function equipo(){
  const [us,pu,dbd]=await Promise.all([leerCol("usuarios"),leerCol("portal_users"),leerCol("departamentos")]);
  const porId={}; DEPTOS_BASE.forEach(d=>porId[d.id]={...d});
  dbd.forEach(d=>{ porId[d._id]={...(porId[d._id]||{}),...d,id:d._id}; });
  const deps=Object.values(porId).filter(d=>d.activo!==false);

  // La rama de Operaciones
  const rama=new Set(RAIZ_DEPTOS);
  let crece=true;
  while(crece){ crece=false; deps.forEach(d=>{ if(!rama.has(d.id)&&d.padre&&rama.has(d.padre)){ rama.add(d.id); crece=true; } }); }

  const ids=new Set(SIEMPRE);
  deps.filter(d=>rama.has(d.id)).forEach(d=>(d.responsableIds||[]).forEach(r=>ids.add(String(r))));

  // Email de cada uno, prefiriendo el personal sobre el buzón genérico
  const emails=new Set();
  const nombreDe={};
  [...us,...pu].forEach(u=>{
    const mio=[u._id,u.id,u.crmId,u.perfilCRM].filter(Boolean).some(k=>ids.has(String(k)));
    if(!mio) return;
    if(u.nombre) nombreDe[u._id]=u.nombre;
    if(u.email) emails.add(String(u.email).toLowerCase().trim());
  });
  const pers=[...emails].filter(e=>!GENERICOS.includes(e));
  const to=pers.length?pers:[...emails];

  // Quién clasifica: el responsable de cada departamento de la rama
  const clasifican=deps.filter(d=>rama.has(d.id)).map(d=>{
    const r=(d.responsableIds||[])[0];
    const u=r?[...us,...pu].find(x=>[x._id,x.id,x.crmId].filter(Boolean).some(k=>String(k)===String(r))):null;
    return {depto:d.nombre, quien:(u&&u.nombre)||""};
  }).filter(x=>x.quien);

  return {to, clasifican};
}

// ── Los correos ──────────────────────────────────────────────────────
function emailDiario(sinMotivo, hoy, ayer, mes, clasifican){
  const imp=sinMotivo.reduce((t,x)=>t+x.imp,0);
  const masViejo=Math.max(...sinMotivo.map(x=>diasEntre(x.desde,hoy)));
  const resp=clasifican.length
    ? clasifican.map(c=>esc(c.quien)+" · "+esc(c.depto)).join(" · ")
    : "Operaciones";

  const filas=sinMotivo.sort((a,b)=>diasEntre(b.desde,hoy)-diasEntre(a.desde,hoy)||b.imp-a.imp)
    .slice(0,10).map(x=>{
    const d=diasEntre(x.desde,hoy);
    const col=d>=3?["#FBE6E4","#A32D2D"]:["#FBF0D9","#B7790A"];
    return `<div style="border-bottom:1px solid #EEF2F1;padding:10px 0">
      <table style="width:100%;border-collapse:collapse"><tr>
        <td style="font-size:14px;font-weight:700;vertical-align:top">${esc(x.cliente||"—")}
          <div style="font-weight:400;font-size:12px;color:#8A9691;margin-top:2px">
            ${esc(x.pedido||"—")}${x.agente?" · "+esc(x.agente):""} · +${x.dias} d de retraso</div></td>
        <td style="text-align:right;white-space:nowrap;vertical-align:top">
          <div style="font-size:14px;font-weight:700">${eur(x.imp)}</div>
          <div style="display:inline-block;background:${col[0]};color:${col[1]};font-size:11px;font-weight:700;
            padding:2px 8px;border-radius:8px;margin-top:3px">${d===0?"hoy":d+(d===1?" día":" días")+" sin motivo"}</div></td>
      </tr></table></div>`;
  }).join("");

  return {
    subject: `🚨 ${sinMotivo.length} pedido${sinMotivo.length===1?"":"s"} sin motivo · ${eur(imp)}`
      + (masViejo>=2?` · el más antiguo, ${masViejo} días`:""),
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;color:#15201D">
      <div style="background:#A32D2D;padding:16px 20px;border-radius:14px 14px 0 0">
        <div style="font-size:12px;color:#F7C1C1">${fLarga(hoy)}</div>
        <div style="font-size:30px;font-weight:700;color:#FCEBEB;line-height:1.2;margin-top:2px">${eur(imp)}</div>
        <div style="font-size:13px;color:#F7C1C1">retenidos en ${sinMotivo.length} pedido${sinMotivo.length===1?"":"s"} que nadie ha explicado</div>
      </div>
      <div style="border:1px solid #C9D3CF;border-top:none;border-radius:0 0 14px 14px;padding:14px 20px">
        ${filas}
        <div style="background:#F3F6F5;border-radius:10px;padding:10px 12px;margin-top:14px;font-size:12.5px;color:#5C6B66;line-height:1.55">
          ${ayer?`Ayer eran ${ayer.n} y ${eur(ayer.imp)}.${ayer.clasificados?` Se han clasificado ${ayer.clasificados}.`:" Ninguno se ha clasificado desde entonces."}<br>`:""}
          ${mes?`En lo que va de mes: ${mes.aTiempo} clasificados en el día, ${mes.tarde} más tarde.<br>`:""}
          Lo clasifica: ${resp}.
        </div>
        <div style="text-align:center;margin-top:16px">
          <a href="${CRM}/pedidos.html" style="display:inline-block;background:#A32D2D;color:#FCEBEB;text-decoration:none;
            padding:12px 26px;border-radius:10px;font-weight:700">Clasificar ahora</a></div>
        <p style="font-size:11px;color:#8A9691;text-align:center;margin:14px 0 0;line-height:1.5">
          Solo se envía si hay pedidos sin motivo · Operaciones y Dirección</p>
      </div></div>`
  };
}

function emailSemanal(todos, hoy){
  const lunes=new Date(hoy+"T12:00:00");
  lunes.setDate(lunes.getDate()-((lunes.getDay()+6)%7));
  const desdeSem=iso(lunes);
  const sem=todos.filter(x=>x.desde>=desdeSem);
  const sinMotivo=sem.filter(x=>!x.motivo).sort((a,b)=>b.imp-a.imp);

  const porM={};
  todos.forEach(x=>{
    const mo=x.motivo||"Sin motivo (responsabilidad del departamento)";
    porM[mo]=porM[mo]||{motivo:mo,n:0,imp:0,dias:0};
    porM[mo].n++; porM[mo].imp+=x.imp; porM[mo].dias+=x.dias;
  });
  const filas=Object.values(porM).sort((a,b)=>b.n-a.n);
  const tot={n:todos.length, imp:todos.reduce((t,x)=>t+x.imp,0),
    dias:todos.length?todos.reduce((t,x)=>t+x.dias,0)/todos.length:0};
  const sinM=todos.filter(x=>!x.motivo).length;

  const th='style="text-align:left;padding:7px 9px;font-size:12px;color:#5C6B66;border-bottom:2px solid #E2E8F0"';
  const td='style="padding:7px 9px;font-size:13px;border-bottom:1px solid #EEF2F1"';
  const tdn='style="padding:7px 9px;font-size:13px;border-bottom:1px solid #EEF2F1;text-align:right;white-space:nowrap"';
  const tdr='style="padding:7px 9px;font-size:13px;border-bottom:1px solid #EEF2F1;color:#C4302B;font-weight:700"';

  return {
    subject:`📊 Retrasos de pedido · ${tot.n} en 60 días · ${eur(tot.imp)}`,
    html:`<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;color:#15201D">
      <div style="background:#15201D;color:#fff;padding:18px 20px;border-radius:14px 14px 0 0">
        <div style="font-size:13px;opacity:.75">${fLarga(hoy)}</div>
        <div style="font-size:21px;font-weight:700;margin-top:2px">🚚 Retrasos de pedido</div>
      </div>
      <div style="border:1px solid #C9D3CF;border-top:none;border-radius:0 0 14px 14px;padding:18px 20px">
        <p style="font-size:19px;margin:0 0 4px"><b>${tot.n}</b> pedido${tot.n===1?"":"s"} retrasado${tot.n===1?"":"s"} en 60 días ·
          <b>${eur(tot.imp)}</b> · <b>${d1(tot.dias)} días</b> de media</p>
        ${sinM?`<p style="background:#FBE6E4;color:#7E1E1A;border-radius:10px;padding:9px 12px;margin:10px 0;font-size:14px">
          <b>${sinM}</b> siguen <b>sin motivo</b>: se cuentan como responsabilidad del departamento.</p>`:""}

        <h3 style="font-size:15px;margin:18px 0 6px">Por qué se retrasan · últimos 60 días</h3>
        <table style="width:100%;border-collapse:collapse">
          <tr><th ${th}>Motivo</th><th ${th} style="text-align:right">Pedidos</th>
            <th ${th} style="text-align:right">Días medios</th><th ${th} style="text-align:right">Importe</th></tr>
          ${filas.map(m=>{
            const sm=/^Sin motivo/.test(m.motivo);
            return `<tr><td ${sm?tdr:td}>${esc(m.motivo)}</td><td ${tdn}>${m.n}</td>
              <td ${tdn}>${d1(m.dias/m.n)}</td><td ${tdn}>${eur(m.imp)}</td></tr>`;
          }).join("")}
          <tr><td ${td}><b>Total</b></td><td ${tdn}><b>${tot.n}</b></td>
            <td ${tdn}><b>${d1(tot.dias)}</b></td><td ${tdn}><b>${eur(tot.imp)}</b></td></tr>
        </table>

        <h3 style="font-size:15px;margin:22px 0 6px">Esta semana, sin motivo</h3>
        ${sinMotivo.length?`
          <p style="font-size:14px;margin:0 0 8px">${sinMotivo.length} pedido${sinMotivo.length===1?"":"s"} ·
            <b style="color:#C4302B">${eur(sinMotivo.reduce((t,x)=>t+x.imp,0))}</b> que no salieron cuando debían.</p>
          <table style="width:100%;border-collapse:collapse">
            <tr><th ${th}>Cliente</th><th ${th}>Pedido</th><th ${th} style="text-align:right">Días</th>
              <th ${th} style="text-align:right">Importe</th></tr>
            ${sinMotivo.slice(0,15).map(x=>`<tr>
              <td ${td}>${esc(x.cliente||"—")}${x.agente?`<br><span style="font-size:11.5px;color:#5C6B66">${esc(x.agente)}</span>`:""}</td>
              <td ${td}>${esc(x.pedido||"—")}${x.articulo?`<br><span style="font-size:11.5px;color:#5C6B66">${esc(x.articulo).slice(0,38)}</span>`:""}</td>
              <td ${tdn}>+${x.dias}</td><td ${tdn}>${eur(x.imp)}</td></tr>`).join("")}
          </table>`
        :`<p style="background:#E2F3E8;color:#145E35;border-radius:10px;padding:10px 12px;font-size:14px;margin:0">
            ✅ Todos los retrasos de esta semana están clasificados.</p>`}

        <div style="text-align:center;margin-top:20px">
          <a href="${CRM}/pedidos.html" style="display:inline-block;background:#15201D;color:#fff;text-decoration:none;
            padding:12px 26px;border-radius:10px;font-weight:700">Ver los pedidos</a></div>
        <p style="font-size:11.5px;color:#8A9691;margin:16px 0 0;text-align:center">
          Aviso automático del CRM · resumen semanal a Operaciones y Dirección</p>
      </div></div>`
  };
}

async function enviar(to,subject,html){
  const base=process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? "https://"+process.env.VERCEL_PROJECT_PRODUCTION_URL : CRM;
  const r=await fetch(base+"/api/send-email",{method:"POST",
    headers:{"Content-Type":"application/json"},body:JSON.stringify({to,subject,html})});
  return r.ok;
}

module.exports = async function handler(req,res){
  try{
    const q=req.query||{};
    const sec=process.env.CRON_SECRET;
    if(sec && q.secret!==sec){ res.status(401).json({error:"falta el secreto"}); return; }

    const tipo   = q.tipo==="semanal" ? "semanal" : "diario";
    const probar = q.probar==="1";
    const hoy    = q.fecha || iso(new Date());

    const [todos,{to,clasifican}] = await Promise.all([cargarRetrasos(new Date(hoy+"T12:00:00")), equipo()]);
    const sinMotivo = todos.filter(x=>!x.motivo);

    if(tipo==="diario" && !sinMotivo.length){
      // Nada pendiente: no se envía. Recibirlo es el aviso; no recibirlo, la recompensa.
      res.status(200).json({ok:true, tipo, enviado:false, motivo:"no hay pedidos sin clasificar"});
      return;
    }

    let correo, memoria=null;
    if(tipo==="diario"){
      const prev = await leerDoc("configuracion/avisos_retrasos");
      let ayer=null, mes=null;
      if(prev){
        let ids=[]; try{ ids=JSON.parse(prev.ids||"[]"); }catch(e){}
        const ahora=new Set(sinMotivo.map(x=>x.k));
        ayer={n:Number(prev.n)||0, imp:Number(prev.imp)||0,
              clasificados: ids.filter(k=>!ahora.has(k)).length};
        const mesAct=hoy.slice(0,7);
        mes = (prev.mes===mesAct)
          ? {aTiempo:Number(prev.aTiempo)||0, tarde:Number(prev.tarde)||0}
          : {aTiempo:0, tarde:0};
        // Clasificado el mismo día que apareció = a tiempo; si no, tarde
        ids.filter(k=>!ahora.has(k)).forEach(k=>{
          const x=todos.find(y=>y.k===k);
          if(!x) return;
          if(diasEntre(x.desde,hoy)<=1) mes.aTiempo++; else mes.tarde++;
        });
        memoria={mes:mesAct, aTiempo:mes.aTiempo, tarde:mes.tarde};
      } else {
        memoria={mes:hoy.slice(0,7), aTiempo:0, tarde:0};
      }
      correo=emailDiario(sinMotivo,hoy,ayer,mes,clasifican);
      memoria.n=sinMotivo.length;
      memoria.imp=sinMotivo.reduce((t,x)=>t+x.imp,0);
      memoria.ids=JSON.stringify(sinMotivo.map(x=>x.k));
      memoria.ultimoEnvio=new Date().toISOString();
    } else {
      correo=emailSemanal(todos,hoy);
    }

    if(probar){
      res.status(200).json({ok:true,tipo,to,asunto:correo.subject,
        retrasos:todos.length,sinMotivo:sinMotivo.length,clasifican,html:correo.html});
      return;
    }
    if(!to.length){ res.status(200).json({ok:false,error:"sin destinatarios con email"}); return; }

    const ok=await enviar(to,correo.subject,correo.html);
    if(ok&&memoria) await guardarDoc("configuracion/avisos_retrasos",memoria);
    res.status(200).json({ok,tipo,to,asunto:correo.subject,
      retrasos:todos.length,sinMotivo:sinMotivo.length});
  }catch(e){
    res.status(500).json({error:String(e&&e.message||e)});
  }
};
