// api/notificar-incidencia.js
// Envía email a los responsables cuando se crea una incidencia
// y también sirve como worker para los recordatorios diarios.
//
// POST inmediato: { incidenciaId } → notifica a los responsables de esa incidencia
// GET (cron):    sin params       → procesa todas las abiertas y envía recordatorios
//
// (v5.5) ALINEADO CON EL ORGANIGRAMA:
// - Los destinatarios salen de la colección "departamentos": el depto cuya
//   lista `tipologias` incluye el tipo de la incidencia → TODOS sus
//   `responsableIds` reciben el email (antes: un solo email fijo).
// - Escalado: los responsables del departamento PADRE van en copia
//   (ej. incidencia de Producción → responsables de Producción + copia a
//   los de Operaciones). Dirección no se copia (el CRM ya avisa a CEO/dir).
// - Compatibilidad: se mantienen los perfiles antiguos resp_* y cualquier
//   ficha con campo `tipologia` coincidente. Cuentas con `duplicadaDe` o
//   `activo:false` se ignoran.
// - Un solo fetch de cada colección por invocación (el cron ya no
//   redescarga usuarios por cada incidencia).

const FB = "https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents";

// (v3.23.95) Copia automática en TODOS los emails de notificación de incidencias.
// Para añadir más copias, separa con comas: "antonio@unitedcaro.com, otro@x.com"
const CC_SIEMPRE = "antonio@unitedcaro.com";

function fsToObj(doc){
  if(!doc||!doc.fields) return null;
  const o={};
  for(const k in doc.fields){
    const v=doc.fields[k];
    if(v.stringValue!==undefined) o[k]=v.stringValue;
    else if(v.integerValue!==undefined) o[k]=parseInt(v.integerValue);
    else if(v.doubleValue!==undefined) o[k]=Number(v.doubleValue);
    else if(v.booleanValue!==undefined) o[k]=v.booleanValue;
    else if(v.timestampValue!==undefined) o[k]=v.timestampValue;
    else if(v.arrayValue && v.arrayValue.values){
      o[k]=v.arrayValue.values.map(x=>x.stringValue||x.integerValue||x);
    }
  }
  return o;
}

async function listColeccion(col){
  const out=[]; let tok=null, pages=0;
  do{
    const u=FB+"/"+col+"?pageSize=300"+(tok?"&pageToken="+tok:"");
    const r=await fetch(u);
    if(!r.ok) return out;
    const j=await r.json();
    if(j.documents) j.documents.forEach(d=>{
      const o=fsToObj(d);
      if(o){ o._id=d.name.split("/").pop(); out.push(o); }
    });
    tok=j.nextPageToken; pages++;
  }while(tok && pages<20);
  return out;
}

async function getDoc(col,id){
  const r=await fetch(FB+"/"+col+"/"+encodeURIComponent(id));
  if(!r.ok) return null;
  const j=await r.json();
  const o=fsToObj(j); if(o) o._id=id;
  return o;
}

async function setCampo(col,id,campo,valor){
  const url=FB+"/"+col+"/"+encodeURIComponent(id)+"?updateMask.fieldPaths="+campo;
  const body={fields:{}};
  if(typeof valor==="string") body.fields[campo]={stringValue:valor};
  else if(typeof valor==="number") body.fields[campo]=Number.isInteger(valor)?{integerValue:valor}:{doubleValue:valor};
  else if(typeof valor==="boolean") body.fields[campo]={booleanValue:valor};
  const r=await fetch(url,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  return r.ok;
}

// Mapeo tipo de incidencia → tipología del responsable
const TIPO_A_TIPOLOGIA = {
  calidad:        "calidad",
  logistica:      "logistica",
  administracion: "administracion",
  stock:          "stock",
  rotura:         "stock",
  produccion:     "produccion",
  id:             "id",
  coordinacion:   "coordinacion"
};
// Etiquetas humanas
const LABEL_TIPO = {
  calidad:"Calidad", logistica:"Logística", administracion:"Administración",
  stock:"Stock", produccion:"Producción", id:"I+D", coordinacion:"Coordinación"
};

// Mapeo id de cuenta legacy → tipología (perfiles resp_* antiguos)
const ID_A_TIPOLOGIA = {
  resp_cal: "calidad",
  resp_log: "logistica",
  resp_adm: "administracion",
  resp_stk: "stock",
  resp_prd: "produccion",
  resp_id:  "id",
  resp_coord: "coordinacion"
};

// ─────────────────────────────────────────────────────────────────────
// (v5.5) Resolución de destinatarios desde el ORGANIGRAMA
// ─────────────────────────────────────────────────────────────────────

// (sep 2026) Organigrama base: el mismo que lleva el CRM en su codigo. En la
// base de datos solo estan los departamentos creados o editados desde el panel;
// Calidad, Produccion, I+D, Logistica, Administracion... viven solo aqui, y
// sin esta lista el proceso no los encontraba y avisaba a quien no era.
// Lo que haya en la base con el mismo id manda sobre esto.
const DEPARTAMENTOS_BASE = [
  {id:"direccion",     nombre:"Dirección",        padre:null,          responsableIds:["ceo"],       tipologias:[]},
  {id:"ventas",        nombre:"Ventas",           padre:"direccion",   responsableIds:["dir"],       tipologias:[]},
  {id:"customer",      nombre:"Customer Service", padre:"ventas",      responsableIds:[],            tipologias:[]},
  {id:"compras",       nombre:"Compras",          padre:"direccion",   responsableIds:["compras"],   tipologias:["stock"]},
  {id:"logistica",     nombre:"Logística",        padre:"compras",     responsableIds:["resp_log"],  tipologias:["logistica"]},
  {id:"operaciones",   nombre:"Operaciones",      padre:"direccion",   responsableIds:[],            tipologias:[]},
  {id:"produccion",    nombre:"Producción",       padre:"operaciones", responsableIds:["resp_prd"],  tipologias:["produccion"]},
  {id:"coordinacion",  nombre:"Coordinación",     padre:"operaciones", responsableIds:["resp_coord"],tipologias:["coordinacion"]},
  {id:"id",            nombre:"I+D",              padre:"direccion",   responsableIds:["resp_id"],   tipologias:["id"]},
  {id:"ingredientes",  nombre:"Ingredientes",     padre:"id",          responsableIds:[],            tipologias:[]},
  {id:"envolturas",    nombre:"Envolturas",       padre:"id",          responsableIds:[],            tipologias:[]},
  {id:"calidad",       nombre:"Calidad",          padre:"direccion",   responsableIds:["resp_cal"],  tipologias:["calidad"]},
  {id:"administracion",nombre:"Administración",   padre:"direccion",   responsableIds:["resp_adm"],  tipologias:["administracion"]},
  {id:"it",            nombre:"IT",               padre:"direccion",   responsableIds:["resp_it"],   tipologias:["it"]},
];

// Carga las 3 colecciones UNA vez por invocación
async function cargarDatos(){
  const [depsBD, portal, usuarios] = await Promise.all([
    listColeccion("departamentos"),
    listColeccion("portal_users"),
    listColeccion("usuarios"),
  ]);
  // Base + lo de la base de datos, que manda si coincide el id
  const porId={};
  DEPARTAMENTOS_BASE.forEach(d=>{ porId[d.id]={...d,_id:d.id,activo:true}; });
  depsBD.forEach(d=>{ const id=d._id||d.id; porId[id]={...(porId[id]||{}),...d,_id:id}; });
  return {departamentos:Object.values(porId), portal, usuarios};
}

function cuentaValida(u){
  return u && !u.duplicadaDe && u.activo!==false && !u._legacy;
}

// Buzones compartidos: solo se usan si la persona no tiene otro email
const EMAILS_GENERICOS=["info@unitedcaro.com"];

// Todas las cuentas (portal + usuarios) de una persona por id, deduplicadas
function emailDeCuenta(datos, cuentaId){
  if(!cuentaId) return null;
  const idN=String(cuentaId).toLowerCase();
  // (sep 2026) Para buscar el EMAIL no se descartan las fichas marcadas como
  // duplicadas: siguen siendo de la misma persona. La de Resp. Calidad estaba
  // marcada como duplicada de si misma y por eso su email no se usaba nunca.
  const coincide=u=>{
    if(!u||u.activo===false) return false;
    return [u.id,u._id,u.crmId,u.perfilCRM,u.username]
      .some(k=>k&&String(k).toLowerCase()===idN);
  };
  // (sep 2026) La misma persona puede tener email en la ficha del CRM y en la
  // del portal, y el panel de administrador actualiza la del portal. Se reunen
  // todos y se prefiere uno personal: si se cambia el del portal y la otra
  // ficha conserva el buzon generico, debe ganar el personal.
  const cands=[];
  datos.usuarios.filter(u=>coincide(u)&&u.email).forEach(u=>cands.push(u.email));
  datos.portal.filter(u=>coincide(u)&&u.email).forEach(u=>cands.push(u.email));
  datos.portal.filter(u=>u&&u.activo!==false&&u.email&&u.crmId&&String(u.crmId).toLowerCase()===idN)
    .forEach(u=>cands.push(u.email));
  if(!cands.length) return null;
  const personal=cands.find(e=>EMAILS_GENERICOS.indexOf(String(e).toLowerCase().trim())<0);
  return personal||cands[0];
}

// ¿Este departamento corresponde a esta tipologia? Por su lista de
// tipologias, por su id o (sep 2026) por su nombre: el de Calidad del
// organigrama no tenia ni id ni tipologia "calidad" y no se encontraba.
function _norm(x){ return String(x||"").toLowerCase().normalize("NFD")
  .replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,""); }
function casaDepto(d,tipologia){
  const t=_norm(tipologia);
  const tips=(d.tipologias||[]).map(_norm);
  if(tips.indexOf(t)>=0) return true;
  if(_norm(d._id||d.id)===t) return true;
  const lbl=_norm(LABEL_TIPO[tipologia]||tipologia);
  return _norm(d.nombre)===t||_norm(d.nombre)===lbl;
}

// Destinatarios de una tipología según el organigrama:
// { directos:[emails], escalado:[emails del depto padre] }
function destinatariosDe(datos, tipologia){
  const directos=new Set(), escalado=new Set();
  const addD=e=>{ if(e) directos.add(String(e).toLowerCase()); };
  const addE=e=>{ if(e) escalado.add(String(e).toLowerCase()); };

  // 1. Departamento del organigrama cuya lista `tipologias` incluye este tipo,
  //    o cuyo id ES el tipo (tipos generados por departamento, v5.5)
  // (sep 2026) Antes se cogia solo el PRIMER departamento que casaba: si habia
  // dos (uno antiguo y el del organigrama nuevo) y el primero no tenia
  // responsable con email, no se avisaba a nadie. Ahora se recorren todos.
  const deps=datos.departamentos.filter(d=>{
    if(d.activo===false) return false;
    return casaDepto(d,tipologia);
  });
  deps.forEach(dep=>{
    (dep.responsableIds||[]).forEach(rid=>addD(emailDeCuenta(datos,rid)));
    // Escalado: responsables del departamento PADRE (excepto dirección)
    if(dep.padre && dep.padre!=="direccion"){
      const padre=datos.departamentos.find(d=>d._id===dep.padre||d.id===dep.padre);
      if(padre&&padre.activo!==false){
        (padre.responsableIds||[]).forEach(rid=>addE(emailDeCuenta(datos,rid)));
      }
    }
  });

  // 2. Compatibilidad: cualquier ficha con campo `tipologia` coincidente
  //    o con id legacy resp_* (comportamiento anterior, ahora aditivo)
  [datos.portal, datos.usuarios].forEach(col=>{
    col.forEach(u=>{
      if(!cuentaValida(u)||!u.email) return;
      const tip=String(u.tipologia||ID_A_TIPOLOGIA[u.id||u._id]||"").toLowerCase();
      if(tip===tipologia) addD(u.email);
    });
  });

  // Si hay algun email personal, el buzon generico sobra
  if([...directos].some(e=>EMAILS_GENERICOS.indexOf(e)<0))
    EMAILS_GENERICOS.forEach(g=>directos.delete(g));

  // Quien ya recibe directo no necesita copia de escalado
  escalado.forEach(e=>{ if(directos.has(e)) escalado.delete(e); });
  return {directos:[...directos], escalado:[...escalado]};
}

// Días entre dos fechas (a partir de una fecha dd/mm/aaaa o ISO)
function diasDesde(fechaRaw){
  if(!fechaRaw) return 0;
  let d;
  if(typeof fechaRaw==="string" && fechaRaw.indexOf("/")>=0){
    const p=fechaRaw.split("/");
    if(p.length<3) return 0;
    const ano=p[2].length===2?"20"+p[2]:p[2];
    d=new Date(parseInt(ano), parseInt(p[1])-1, parseInt(p[0]));
  } else {
    d=new Date(fechaRaw);
  }
  if(isNaN(d)) return 0;
  return Math.floor((Date.now()-d.getTime())/(1000*60*60*24));
}

// Construye y envía un email a una lista de destinatarios (array o string)
async function enviarEmail(to, subject, text){
  if(!to) return {ok:false, error:"sin destinatario"};
  const lista=Array.isArray(to)?to:String(to).split(/[;,]/);
  const destinatarios = lista
    .map(s=>String(s).trim())
    .filter(s=>s.length>0 && s.indexOf("@")>0);
  if(destinatarios.length===0) return {ok:false, error:"destinatario inválido"};

  // (v3.23.95) Añadir copias automáticas (CC_SIEMPRE), evitando duplicados
  const finales = destinatarios.slice();
  String(CC_SIEMPRE||"")
    .split(/[;,]/)
    .map(s=>s.trim())
    .filter(s=>s.length>0 && s.indexOf("@")>0)
    .forEach(cc=>{
      const yaEsta = finales.some(d=>d.toLowerCase()===cc.toLowerCase());
      if(!yaEsta) finales.push(cc);
    });

  // (sep 2026) VERCEL_URL es la direccion INTERNA del despliegue: con la
  // proteccion de despliegues activada exige identificarse, la llamada falla
  // en silencio y el correo no sale. Se usa siempre el dominio publico.
  const base=process.env.VERCEL_PROJECT_PRODUCTION_URL
    ?("https://"+process.env.VERCEL_PROJECT_PRODUCTION_URL)
    :"https://crmwikuk.vercel.app";
  const r=await fetch(base+"/api/send-email",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({to:finales, subject, text})
  });
  let body=null;
  try{ body = await r.text(); }catch(e){}
  return {ok:r.ok, status:r.status, destinatarios:finales, response:body};
}

// Construye cuerpo y asunto según es nuevo o recordatorio
function construirEmail(inc, dias, esEscalado){
  const tipo = LABEL_TIPO[TIPO_A_TIPOLOGIA[String(inc.tipo||"").toLowerCase()]] || inc.tipo || "—";
  const cliente = inc.cliente || inc.clienteNombre || "—";
  const prio = (inc.prioridad||"media").toLowerCase();
  const prioEtiq = prio==="alta"||prio==="urgente" ? "🔴 ALTA" : prio==="baja" ? "⚪ Baja" : "🟡 Media";
  const linkCRM = "https://crmwikuk.vercel.app/";

  let subject, intro;
  if(esEscalado){
    subject = "📋 (Info) Incidencia de "+tipo+" en tu área — "+cliente;
    intro = "Se ha registrado una incidencia en un departamento a tu cargo. Sus responsables ya han sido avisados; esto es una copia informativa:";
  } else if(dias===0){
    subject = "🆕 Nueva incidencia de "+tipo+" — "+cliente;
    intro = "Se ha registrado una nueva incidencia que requiere tu atención:";
  } else if(dias===1){
    subject = "⏰ Recordatorio · Incidencia abierta "+dias+" día — "+cliente;
    intro = "Tienes una incidencia abierta desde ayer sin respuesta:";
  } else {
    subject = "⏰ Recordatorio · Incidencia abierta "+dias+" días — "+cliente;
    intro = "Tienes una incidencia abierta desde hace "+dias+" días sin respuesta:";
  }

  const body =
    intro+"\n\n"+
    "▸ Cliente: "+cliente+"\n"+
    "▸ Tipo: "+tipo+"\n"+
    "▸ Prioridad: "+prioEtiq+"\n"+
    "▸ Fecha de creación: "+(inc.fecha||"—")+"\n\n"+
    "Descripción:\n"+(inc.descripcion||"(sin descripción)")+"\n\n"+
    "Para gestionarla, entra al CRM:\n"+linkCRM+"\n\n"+
    "—\nCRM Grupo Consolidado · Aviso automático";

  return {subject, body};
}

const DIAS_HIST = 60;
const MIN_DIAS  = 3;            // menos de 3 días no se considera retraso
// Arranque limpio de los avisos: lo anterior queda como historial y no se
// reclama. Se empieza a exigir el motivo desde el 24 de septiembre de 2026.
const DESDE     = "2026-09-24";
const CRM       = "https://crmwikuk.vercel.app";

// Quién recibe cada aviso: Operaciones y lo que cuelga de ella, más dirección
const RAIZ_DEPTOS = ["operaciones"];
const SIEMPRE     = ["ceo", "dir"];
const GENERICOS_R = ["info@unitedcaro.com"];

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
function valR(f){
  if(!f) return null;
  if(f.stringValue!==undefined) return f.stringValue;
  if(f.integerValue!==undefined) return parseInt(f.integerValue);
  if(f.doubleValue!==undefined) return Number(f.doubleValue);
  if(f.booleanValue!==undefined) return f.booleanValue;
  if(f.arrayValue!==undefined) return (f.arrayValue.values||[]).map(valR);
  return null;
}
function objR(doc){
  if(!doc||!doc.fields) return null;
  const o={_id:decodeURIComponent((doc.name||"").split("/").pop())};
  for(const k in doc.fields) o[k]=valR(doc.fields[k]);
  return o;
}
async function leerDocR(ruta){
  const r=await fetch(`${FB}/${ruta}`);
  return r.ok ? objR(await r.json()) : null;
}
async function leerColR(col){
  const out=[]; let tok=null, v=0;
  do{
    const r=await fetch(`${FB}/${col}?pageSize=300`+(tok?"&pageToken="+encodeURIComponent(tok):""));
    if(!r.ok) break;
    const j=await r.json();
    (j.documents||[]).forEach(d=>{ const o=objR(d); if(o) out.push(o); });
    tok=j.nextPageToken||null; v++;
  }while(tok&&v<20);
  return out;
}
async function guardarDocR(ruta,campos){
  const f={};
  for(const k in campos){
    const v=campos[k];
    f[k] = typeof v==="number" ? {doubleValue:v} : {stringValue:String(v==null?"":v)};
  }
  await fetch(`${FB}/${ruta}`,{method:"PATCH",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({fields:f})}).catch(()=>{});
}

// ── Utilidades ───────────────────────────────────────────────────────
const isoR=d=>d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
const eur=n=>Math.round(Number(n)||0).toLocaleString("es-ES")+" €";
const d1 =n=>(Math.round((Number(n)||0)*10)/10).toLocaleString("es-ES").replace(".",",");
const escR=t=>String(t==null?"":t).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
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
  for(let i=0;i<DIAS_HIST;i++){ const d=new Date(hoy); d.setDate(d.getDate()-i); fechas.push(isoR(d)); }

  const docs=[];
  for(let i=0;i<fechas.length;i+=12){
    const t=await Promise.all(fechas.slice(i,i+12).map(f=>
      fetch(`${FB}/pbi_pedidos_cambios/${f}`).then(r=>r.ok?r.json():null).catch(()=>null)));
    t.forEach((d,j)=>{ if(d) docs.push({fecha:fechas[i+j],doc:d}); });
  }

  const motivos={};
  (await leerColR("pbi_retrasos_motivo")).forEach(m=>{
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
  return Object.values(vistos);
}

// ── Destinatarios ────────────────────────────────────────────────────
async function equipoRetrasos(){
  const [us,pu,dbd]=await Promise.all([leerColR("usuarios"),leerColR("portal_users"),leerColR("departamentos")]);
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
  const pers=[...emails].filter(e=>!GENERICOS_R.includes(e));
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
    ? clasifican.map(c=>escR(c.quien)+" · "+escR(c.depto)).join(" · ")
    : "Operaciones";

  const filas=sinMotivo.sort((a,b)=>diasEntre(b.desde,hoy)-diasEntre(a.desde,hoy)||b.imp-a.imp)
    .slice(0,10).map(x=>{
    const d=diasEntre(x.desde,hoy);
    const col=d>=3?["#FBE6E4","#A32D2D"]:["#FBF0D9","#B7790A"];
    return `<div style="border-bottom:1px solid #EEF2F1;padding:10px 0">
      <table style="width:100%;border-collapse:collapse"><tr>
        <td style="font-size:14px;font-weight:700;vertical-align:top">${escR(x.cliente||"—")}
          <div style="font-weight:400;font-size:12px;color:#8A9691;margin-top:2px">
            ${escR(x.pedido||"—")}${x.agente?" · "+escR(x.agente):""} · +${x.dias} d de retraso</div></td>
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

function emailSemanal(todos, hoy, hist){
  const lunes=new Date(hoy+"T12:00:00");
  lunes.setDate(lunes.getDate()-((lunes.getDay()+6)%7));
  const desdeSem=isoR(lunes);
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
            return `<tr><td ${sm?tdr:td}>${escR(m.motivo)}</td><td ${tdn}>${m.n}</td>
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
              <td ${td}>${escR(x.cliente||"—")}${x.agente?`<br><span style="font-size:11.5px;color:#5C6B66">${escR(x.agente)}</span>`:""}</td>
              <td ${td}>${escR(x.pedido||"—")}${x.articulo?`<br><span style="font-size:11.5px;color:#5C6B66">${escR(x.articulo).slice(0,38)}</span>`:""}</td>
              <td ${tdn}>+${x.dias}</td><td ${tdn}>${eur(x.imp)}</td></tr>`).join("")}
          </table>`
        :`<p style="background:#E2F3E8;color:#145E35;border-radius:10px;padding:10px 12px;font-size:14px;margin:0">
            ✅ Todos los retrasos de esta semana están clasificados.</p>`}

        ${hist&&hist.n?`<p style="font-size:12.5px;color:#5C6B66;margin:18px 0 0;line-height:1.5">
          Además hay <b>${hist.n}</b> retrasos anteriores al arranque (${eur(hist.imp)}) sin clasificar.
          Quedan como historial: no hace falta ponerse al día con ellos.</p>`:""}

        <div style="text-align:center;margin-top:20px">
          <a href="${CRM}/pedidos.html" style="display:inline-block;background:#15201D;color:#fff;text-decoration:none;
            padding:12px 26px;border-radius:10px;font-weight:700">Ver los pedidos</a></div>
        <p style="font-size:11.5px;color:#8A9691;margin:16px 0 0;text-align:center">
          Aviso automático del CRM · resumen semanal a Operaciones y Dirección</p>
      </div></div>`
  };
}

async function enviarRetrasos(to,subject,html){
  const base=process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? "https://"+process.env.VERCEL_PROJECT_PRODUCTION_URL : CRM;
  const r=await fetch(base+"/api/send-email",{method:"POST",
    headers:{"Content-Type":"application/json"},body:JSON.stringify({to,subject,html})});
  return r.ok;
}


function emailHistorial(viejos, hoy){
  const porM={};
  viejos.forEach(x=>{
    const mo=x.motivo||"Sin clasificar";
    porM[mo]=porM[mo]||{motivo:mo,n:0,imp:0,dias:0};
    porM[mo].n++; porM[mo].imp+=x.imp; porM[mo].dias+=x.dias;
  });
  const filas=Object.values(porM).sort((a,b)=>b.n-a.n);
  const tot={n:viejos.length,imp:viejos.reduce((t,x)=>t+x.imp,0),
    dias:viejos.length?viejos.reduce((t,x)=>t+x.dias,0)/viejos.length:0};
  const sinM=viejos.filter(x=>!x.motivo).sort((a,b)=>b.imp-a.imp);

  const th='style="text-align:left;padding:7px 9px;font-size:12px;color:#5C6B66;border-bottom:2px solid #E2E8F0"';
  const td='style="padding:7px 9px;font-size:13px;border-bottom:1px solid #EEF2F1"';
  const tdn='style="padding:7px 9px;font-size:13px;border-bottom:1px solid #EEF2F1;text-align:right;white-space:nowrap"';
  const tdr='style="padding:7px 9px;font-size:13px;border-bottom:1px solid #EEF2F1;color:#C4302B;font-weight:700"';

  return {
    subject:`📚 Retrasos anteriores al arranque · ${tot.n} · ${eur(tot.imp)}`,
    html:`<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;color:#15201D">
      <div style="background:#5F5E5A;color:#fff;padding:18px 20px;border-radius:14px 14px 0 0">
        <div style="font-size:13px;opacity:.8">Historial · hasta el ${DESDE}</div>
        <div style="font-size:21px;font-weight:700;margin-top:2px">📚 Retrasos anteriores al arranque</div>
      </div>
      <div style="border:1px solid #C9D3CF;border-top:none;border-radius:0 0 14px 14px;padding:18px 20px">
        <p style="font-size:19px;margin:0 0 4px"><b>${tot.n}</b> retrasos · <b>${eur(tot.imp)}</b> ·
          <b>${d1(tot.dias)} días</b> de media</p>
        <p style="font-size:13px;color:#5C6B66;margin:0 0 14px">No se reclaman: quedan como registro de lo que pasó antes de empezar a exigir el motivo.</p>
        <table style="width:100%;border-collapse:collapse">
          <tr><th ${th}>Motivo</th><th ${th} style="text-align:right">Pedidos</th>
            <th ${th} style="text-align:right">Días medios</th><th ${th} style="text-align:right">Importe</th></tr>
          ${filas.map(m=>{
            const sm=m.motivo==="Sin clasificar";
            return `<tr><td ${sm?tdr:td}>${escR(m.motivo)}</td><td ${tdn}>${m.n}</td>
              <td ${tdn}>${d1(m.dias/m.n)}</td><td ${tdn}>${eur(m.imp)}</td></tr>`;
          }).join("")}
          <tr><td ${td}><b>Total</b></td><td ${tdn}><b>${tot.n}</b></td>
            <td ${tdn}><b>${d1(tot.dias)}</b></td><td ${tdn}><b>${eur(tot.imp)}</b></td></tr>
        </table>
        ${sinM.length?`<h3 style="font-size:15px;margin:22px 0 6px">Los que quedaron sin clasificar</h3>
          <table style="width:100%;border-collapse:collapse">
            <tr><th ${th}>Cliente</th><th ${th}>Pedido</th><th ${th} style="text-align:right">Días</th>
              <th ${th} style="text-align:right">Importe</th></tr>
            ${sinM.slice(0,40).map(x=>`<tr>
              <td ${td}>${escR(x.cliente||"—")}${x.agente?`<br><span style="font-size:11.5px;color:#5C6B66">${escR(x.agente)}</span>`:""}</td>
              <td ${td}>${escR(x.pedido||"—")}<br><span style="font-size:11.5px;color:#5C6B66">${escR(x.desde)}</span></td>
              <td ${tdn}>+${x.dias}</td><td ${tdn}>${eur(x.imp)}</td></tr>`).join("")}
          </table>
          ${sinM.length>40?`<p style="font-size:12.5px;color:#5C6B66;margin:6px 0 0">Y ${sinM.length-40} más.</p>`:""}`:""}
      </div></div>`
  };
}

// Los dos avisos, para llamarlos desde el cron de incidencias o directamente
async function avisoRetrasos(opciones){
  const o=opciones||{};
  const tipo = ["semanal","historial"].includes(o.tipo) ? o.tipo : "diario";
  const hoy  = o.fecha || isoR(new Date());
  const [crudos,{to,clasifican}] = await Promise.all([
    cargarRetrasos(new Date(hoy+"T12:00:00")), equipoRetrasos()]);
  const todos     = crudos.filter(x=>x.desde>=DESDE);
  const sinMotivo = todos.filter(x=>!x.motivo);
  // Lo anterior al arranque: se enseña en el semanal, pero no se reclama
  const viejos    = crudos.filter(x=>x.desde<DESDE&&!x.motivo);
  const hist      = {n:viejos.length, imp:viejos.reduce((t,x)=>t+x.imp,0)};

  if(tipo==="historial"){
    const viejosTodos=crudos.filter(x=>x.desde<DESDE);
    const correoH=emailHistorial(viejosTodos,hoy);
    if(o.probar) return {ok:true,tipo,to,asunto:correoH.subject,
      retrasos:viejosTodos.length,sinMotivo:hist.n,html:correoH.html};
    const dest = o.to
      ? String(o.to).split(/[;,]/).map(x=>x.trim()).filter(x=>x.indexOf("@")>0) : to;
    if(!dest.length) return {ok:false,error:"sin destinatarios con email"};
    const okH=await enviarRetrasos(dest,correoH.subject,correoH.html);
    return {ok:okH,tipo,to:dest,soloPrueba:!!o.to,asunto:correoH.subject,
      retrasos:viejosTodos.length,sinMotivo:hist.n};
  }

  if(tipo==="diario" && !sinMotivo.length)
    return {ok:true,tipo,enviado:false,motivo:"no hay pedidos sin clasificar"};

  let correo, memoria=null;
  if(tipo==="diario"){
    const prev=await leerDocR("configuracion/avisos_retrasos");
    let ayer=null, mes=null;
    if(prev){
      let ids=[]; try{ ids=JSON.parse(prev.ids||"[]"); }catch(e){}
      const ahora=new Set(sinMotivo.map(x=>x.k));
      ayer={n:Number(prev.n)||0,imp:Number(prev.imp)||0,clasificados:ids.filter(k=>!ahora.has(k)).length};
      const mesAct=hoy.slice(0,7);
      mes=(prev.mes===mesAct)?{aTiempo:Number(prev.aTiempo)||0,tarde:Number(prev.tarde)||0}:{aTiempo:0,tarde:0};
      ids.filter(k=>!ahora.has(k)).forEach(k=>{
        const x=todos.find(y=>y.k===k); if(!x) return;
        if(diasEntre(x.desde,hoy)<=1) mes.aTiempo++; else mes.tarde++;
      });
      memoria={mes:mesAct,aTiempo:mes.aTiempo,tarde:mes.tarde};
    } else memoria={mes:hoy.slice(0,7),aTiempo:0,tarde:0};
    correo=emailDiario(sinMotivo,hoy,ayer,mes,clasifican);
    memoria.n=sinMotivo.length;
    memoria.imp=sinMotivo.reduce((t,x)=>t+x.imp,0);
    memoria.ids=JSON.stringify(sinMotivo.map(x=>x.k));
    memoria.ultimoEnvio=new Date().toISOString();
  } else correo=emailSemanal(todos,hoy,hist);

  if(o.probar) return {ok:true,tipo,to,asunto:correo.subject,
    retrasos:todos.length,sinMotivo:sinMotivo.length,clasifican,html:correo.html};

  const destinos = o.to
    ? String(o.to).split(/[;,]/).map(x=>x.trim()).filter(x=>x.indexOf("@")>0) : to;
  if(!destinos.length) return {ok:false,error:"sin destinatarios con email"};

  const ok=await enviarRetrasos(destinos,correo.subject,correo.html);
  if(ok&&memoria&&!o.to) await guardarDocR("configuracion/avisos_retrasos",memoria);
  return {ok,tipo,to:destinos,soloPrueba:!!o.to,asunto:correo.subject,
    retrasos:todos.length,sinMotivo:sinMotivo.length};
}

module.exports = async function handler(req, res){
  try{
    // ─────── Avisos de retrasos de pedido, por URL ───────
    // ?retrasos=diario  ·  ?retrasos=semanal  (+ &to= para probar, &probar=1 para verlo)
    if(req.method==="GET" && req.query && req.query.retrasos
       && ["diario","semanal","historial"].includes(String(req.query.retrasos))){
      const sec=process.env.CRON_SECRET;
      if(sec && req.query.secret!==sec){ res.status(401).json({error:"falta el secreto"}); return; }
      const r=await avisoRetrasos({tipo:String(req.query.retrasos),
        to:req.query.to, probar:req.query.probar==="1", fecha:req.query.fecha});
      res.status(200).json(r); return;
    }

    // ─────── MODO PRUEBA: ?probar=calidad → a quién avisaría, sin enviar ───────
    // Con &enviar=1 manda de verdad un correo de prueba a esos destinatarios.
    if(req.method==="GET" && req.query && req.query.probar){
      const sec=process.env.CRON_SECRET;
      if(sec && req.query.secret!==sec){ res.status(401).json({error:"falta el secreto"}); return; }
      const tip=String(req.query.probar).toLowerCase();
      const tipologia=TIPO_A_TIPOLOGIA[tip]||tip;
      const datos=await cargarDatos();
      const deps=datos.departamentos.filter(d=>casaDepto(d,tipologia))
        .map(d=>({id:d._id,nombre:d.nombre,activo:d.activo!==false,
        responsables:(d.responsableIds||[]).map(r=>({id:r,email:emailDeCuenta(datos,r)||"❌ sin email"}))}));
      const dest=destinatariosDe(datos,tipologia);
      // Quien tiene esta tipologia en su ficha (la via de respaldo)
      const porFicha=[...datos.usuarios,...datos.portal]
        .filter(u=>cuentaValida(u)&&String(u.tipologia||ID_A_TIPOLOGIA[u.id||u._id]||"").toLowerCase()===tipologia)
        .map(u=>({id:u._id,nombre:u.nombre||u.username,email:u.email||"❌ sin email"}));
      const out={tipologia, departamentos:deps, porFicha,
        directos:dest.directos, escalado:dest.escalado, copiaSiempre:CC_SIEMPRE,
        // Si no se encuentra el departamento, el organigrama entero para ver como se llama
        organigrama: deps.length?undefined:datos.departamentos
          .map(d=>({id:d._id,nombre:d.nombre,tipologias:d.tipologias||[],activo:d.activo!==false}))};
      if(req.query.enviar==="1" && dest.directos.length){
        out.envio=await enviarEmail(dest.directos,"🧪 Prueba de aviso de incidencias ("+tipologia+")",
          "Esto es una prueba del aviso de incidencias. Si lo recibes, el circuito funciona.");
      }
      res.status(200).json(out); return;
    }

    // ─────── MODO 1: POST inmediato al crear una incidencia ───────
    if(req.method==="POST"){
      const {incidenciaId} = req.body||{};
      if(!incidenciaId){ res.status(400).json({error:"Falta incidenciaId"}); return; }
      const inc = await getDoc("incidencias", incidenciaId);
      if(!inc){ res.status(404).json({error:"Incidencia no encontrada"}); return; }
      // (v5.5) Tipos no clásicos (departamentos nuevos) pasan tal cual
      const tipoLc = String(inc.tipo||"").toLowerCase();
      const tipologia = TIPO_A_TIPOLOGIA[tipoLc] || tipoLc;
      if(!tipologia){ res.status(200).json({ok:true, skipped:"incidencia sin tipo"}); return; }

      const datos = await cargarDatos();
      const dest = destinatariosDe(datos, tipologia);
      if(dest.directos.length===0 && dest.escalado.length===0){
        res.status(200).json({ok:true, skipped:"sin email configurado para "+tipologia}); return;
      }

      let sendD={ok:true}, sendE={ok:true};
      // Email principal a los responsables directos
      if(dest.directos.length>0){
        const {subject, body} = construirEmail(inc, 0, false);
        sendD = await enviarEmail(dest.directos, subject, body);
      }
      // Copia informativa a los responsables del departamento padre
      if(dest.escalado.length>0){
        const {subject, body} = construirEmail(inc, 0, true);
        sendE = await enviarEmail(dest.escalado, subject, body);
      }
      if(sendD.ok){
        await setCampo("incidencias", incidenciaId, "ultimoAvisoFecha", new Date().toISOString());
        await setCampo("incidencias", incidenciaId, "ultimoAvisoTipo", "creacion");
      }
      res.status(200).json({
        ok:sendD.ok,
        to:sendD.destinatarios||[],
        escaladoA:sendE.destinatarios||[],
        status:sendD.status,
        response: sendD.response ? String(sendD.response).substring(0,200) : null
      });
      return;
    }

    // ─────── MODO 2: GET (cron diario) — repasar y enviar recordatorios ───────
    const [incidencias, datos] = await Promise.all([
      listColeccion("incidencias"),
      cargarDatos(),
    ]);
    const hoy = new Date();
    const hoyISO = hoy.toISOString().substring(0,10); // yyyy-mm-dd

    const abiertas = incidencias.filter(i=>{
      if(i.eliminada) return false;
      const e = i.estado||"abierta";
      return e==="abierta"; // solo abiertas: en_proceso, resuelta, cerrada se excluyen
    });

    let enviadas=0, saltadas=0, sinEmail=0, fallidas=0;
    const errores=[];
    for(const inc of abiertas){
      const dias = diasDesde(inc.fecha);
      if(dias<1) continue; // 0 días = se acaba de crear, ya tiene su email inicial

      // No enviar más de uno por día — si ya se envió hoy, saltar
      const ultimoISO = (inc.ultimoAvisoFecha||"").substring(0,10);
      if(ultimoISO===hoyISO){ saltadas++; continue; }

      const tipoLc = String(inc.tipo||"").toLowerCase();
      const tipologia = TIPO_A_TIPOLOGIA[tipoLc] || tipoLc; // (v5.5) pass-through
      if(!tipologia){ saltadas++; continue; }
      const dest = destinatariosDe(datos, tipologia);
      if(dest.directos.length===0){ sinEmail++; continue; }

      // Recordatorios: solo a los responsables directos (sin escalado diario)
      const {subject, body} = construirEmail(inc, dias, false);
      const send = await enviarEmail(dest.directos, subject, body);
      if(send.ok){
        // (v3.23.94) Solo marcar como avisada si el envío fue OK
        await setCampo("incidencias", inc._id, "ultimoAvisoFecha", new Date().toISOString());
        await setCampo("incidencias", inc._id, "ultimoAvisoTipo", "recordatorio_d"+dias);
        enviadas++;
      } else {
        fallidas++;
        errores.push({
          id: inc._id,
          tipo: inc.tipo,
          destinatarios: send.destinatarios,
          status: send.status,
          response: send.response ? String(send.response).substring(0, 200) : null
        });
      }
    }

    // (sep 2026) De paso, los avisos de retrasos de pedido, para no tener que
    // programar otro cron: el diario todos los días (solo sale si hay pedidos
    // sin clasificar) y el resumen completo los lunes.
    let retrasos=null;
    if(String((req.query||{}).sinRetrasos||"")!=="1"){
      try{
        const tipos=(new Date().getDay()===1) ? ["semanal","diario"] : ["diario"];
        retrasos={};
        for(const t of tipos) retrasos[t]=await avisoRetrasos({tipo:t});
      }catch(e){ retrasos={error:String(e&&e.message||e)}; }
    }

    res.status(200).json({
      ok:true,
      revisadas: abiertas.length,
      enviadas, saltadas, sinEmail, fallidas,
      retrasos,
      errores: errores.length>0 ? errores.slice(0,5) : undefined
    });
  } catch(e){
    res.status(500).json({error:String(e&&e.message||e)});
  }
};
