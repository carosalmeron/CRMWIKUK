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

// ═════════════════════════════════════════════════════════════════════
//  (sep 2026) INFORME SEMANAL DE DIRECCIÓN (CEO)
//  Un solo correo con todos los equipos, en vez de recibir cada cierre
//  suelto. Mismos calculos que el consolidado del jefe (objetivos_equipo):
//  la nota de cada comercial es la misma en los dos correos.
//  Sale el sabado (el viernes cierran comerciales y jefes) y una sola vez
//  por semana: se apunta en informes_ceo/<año>_s<semana>.
//  Por URL: ?ceo=semanal [&probar=1 devuelve el html] [&to=x@y] [&semana=39]
// ═════════════════════════════════════════════════════════════════════
const CEO_PESOS={venta:40,margen:20,actividad:25,cobro:15};

async function leerTodoC(col){
  const out=[]; let tok=null, v=0;
  do{
    const r=await fetch(`${FB}/${col}?pageSize=300`+(tok?"&pageToken="+encodeURIComponent(tok):""));
    if(!r.ok) break;
    const j=await r.json();
    (j.documents||[]).forEach(d=>{ const o=objR(d); if(o) out.push(o); });
    tok=j.nextPageToken||null; v++;
  }while(tok&&v<60);
  return out;
}
const numC=x=>Number(x||0)||0;
const UC=s=>String(s||"").toUpperCase().trim();
const eurC=n=>String(Math.round(Number(n)||0)).replace(/\B(?=(\d{3})+(?!\d))/g,".")+" €";
const decC=v=>(Math.round(v*10)/10).toFixed(1).replace(".",",");

// --- Identidad de comercial: misma logica que agentes.js ---------------
function normC(s){ return String(s==null?"":s).toUpperCase().trim()
  .normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^A-Z0-9]/g,""); }
function variantesC(c){
  c=normC(c); if(!c) return [];
  const out=[c];
  for(let i=0;i<c.length;i++) if(c.charAt(i)==="0") out.push(c.slice(0,i)+c.slice(i+1));
  const m=c.match(/^([A-Z]*)(\d+)$/);
  if(m){ out.push(m[1]+"0"+m[2]); out.push(m[2]); out.push("U"+m[2]); }
  return out.filter((v,ix,a)=>v&&a.indexOf(v)===ix);
}
function crearAgentes(filas){
  const MAPA={};
  filas.forEach(o=>{
    const a=normC(o.alias||o._id); if(!a||!o.canonico) return;
    MAPA[a]={canonico:o.canonico,nombre:o.nombre||o.canonico,equipo:o.equipo||""};
  });
  const ficha=x=>{ const k=normC(x); if(!k) return null; if(MAPA[k]) return MAPA[k];
    for(const v of variantesC(k)) if(MAPA[v]) return MAPA[v]; return null; };
  const mismo=(a,b)=>{ if(!a||!b) return false;
    const fa=ficha(a), fb=ficha(b);
    if(fa&&fb) return fa.canonico===fb.canonico;
    const va=variantesC(a), vb=variantesC(b); return va.some(x=>vb.indexOf(x)>=0); };
  const CAMPOS=["agente","agenteId","agenteNombre","responsableComercial","creadoPor","vendedor","comercial","uid"];
  const esDe=(doc,p)=>CAMPOS.some(c=>doc[c]&&mismo(doc[c],p));
  return {ficha,mismo,esDe,
    id:x=>{ const f=ficha(x); return f?f.canonico:(x?String(x):""); },
    nombre:x=>{ const f=ficha(x); return f?f.nombre:(x?String(x):""); },
    equipo:x=>{ const f=ficha(x); return f?f.equipo:""; },
    conocido:x=>!!ficha(x)};
}

function isoSemanaC(d){
  const t=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));
  const dn=t.getUTCDay()||7; t.setUTCDate(t.getUTCDate()+4-dn);
  const a=new Date(Date.UTC(t.getUTCFullYear(),0,1));
  return {sem:Math.ceil((((t-a)/86400000)+1)/7), anio:t.getUTCFullYear()};
}
function lunesC(anio,sem){
  const e=new Date(anio,0,4);
  const l=new Date(e); l.setDate(e.getDate()-((e.getDay()||7)-1));
  l.setDate(l.getDate()+(sem-1)*7); l.setHours(0,0,0,0); return l;
}
function fechaC(v){
  if(!v) return null; const s=String(v);
  let m=s.match(/^(\d{4})-(\d{2})-(\d{2})/); if(m) return new Date(+m[1],+m[2]-1,+m[3]);
  m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if(m){ let a=+m[3]; if(a<100) a+=2000; return new Date(a,+m[2]-1,+m[1]); }
  const d=new Date(s); return isNaN(d.getTime())?null:d;
}
const fechaDocC=o=>{ for(const c of ["fecha","fechaCreacion","creadoEl","fechaAlta","fechaSolicitud","createdAt","fechaEnvio"]){
  const d=fechaC(o[c]); if(d) return d; } return null; };

async function datosCEO(anio,sem){
  const lunes=lunesC(anio,sem);
  const domingo=new Date(lunes); domingo.setDate(lunes.getDate()+6); domingo.setHours(23,59,59,999);
  const jueves=new Date(lunes); jueves.setDate(lunes.getDate()+3);
  const mNum=jueves.getMonth()+1;
  const hace30=new Date(lunes); hace30.setDate(lunes.getDate()-30);
  const enSem=d=>d&&d>=lunes&&d<=domingo;

  const [alias,us,pu,inf,res,cob,estac,objs,objEq,mues,vis,sems,objSem]=await Promise.all([
    leerTodoC("agentes_alias"),leerTodoC("usuarios"),leerTodoC("portal_users"),leerTodoC("informes"),
    leerTodoC("pbi_resumen_agente"),leerTodoC("cobros_comercial"),leerTodoC("pbi_estacionalidad"),
    leerTodoC("pbi_objetivos"),leerTodoC("objetivos_equipo"),leerTodoC("muestras"),leerTodoC("visitas"),
    leerTodoC("pbi_semanas"),leerTodoC("objetivos_semana")]);
  const A=crearAgentes(alias);

  // Comerciales: misma regla que cargarUsuarios() de objetivos_equipo
  const NO_PERSONA=/^(interc|clientsdirect|cataluna|cataluña|tienda|telefono|sinagente|_?total|campofrio|wikuk|interkey|francia|distribuidor)/i;
  const esCanal=x=>NO_PERSONA.test(String(x||"").replace(/[.\s_-]/g,""));
  const map={};
  [...us,...pu].forEach(u=>{
    const rol=String(u.rol||"").toLowerCase();
    if(!["agente","crm_agente","comercial","vendedor"].includes(rol)) return;
    if(u.activo===false) return;
    const pos=[u.id,u._id,u.crmId,u.grupoAgente,u.catalogoVendedor,u.username,u.nombre].filter(Boolean);
    let canon=null,ficha=null;
    for(const k of pos) if(A.conocido(k)){ canon=A.id(k); ficha=k; break; }
    if(!canon){ canon=u.id||u._id||u.username; ficha=canon; }
    if(!canon) return;
    const nombre=A.nombre(ficha)||u.nombre||u.username||canon;
    if(esCanal(nombre)||esCanal(canon)||esCanal(u.catalogoVendedor)) return;
    if(/^u_\d+$/i.test(String(nombre))) return;
    if(!map[canon]) map[canon]={id:canon,nombre,equipo:UC(A.equipo(ficha)||u.equipo||""),
      cod:UC(u.grupoAgente||u.catalogoVendedor||canon),
      perfil:String(u.perfilComercial||"").toLowerCase(),
      entrega:String(u.entregaParte||"").toLowerCase()};
    else{ const m=map[canon];
      if(nombre.length>m.nombre.length&&!/^[a-z]+$/.test(nombre)) m.nombre=nombre;
      if(!m.equipo&&u.equipo) m.equipo=UC(u.equipo);
      if(!m.perfil&&u.perfilComercial) m.perfil=String(u.perfilComercial).toLowerCase();
      if(!m.entrega&&u.entregaParte) m.entrega=String(u.entregaParte).toLowerCase(); }
  });
  const gente=Object.values(map).filter(g=>g.equipo);

  // Jefes por equipo, para el nombre en la tarjeta
  const jefes={};
  us.forEach(u=>{ const r=String(u.rol||"").toLowerCase();
    if((r==="jefe"||r==="crm_jefe")&&u.equipo&&!jefes[UC(u.equipo)]) jefes[UC(u.equipo)]=u.nombre||u._id; });

  const suyo=(lista,g)=>lista.find(x=>A.mismo(x._id,g.cod)||A.mismo(x._id,g.id)||
    A.mismo(x.agente,g.cod)||A.mismo(x.comercial,g.cod)||A.mismo(x.comercialNombre,g.nombre))||{};
  const deQuien=(d,g)=>A.esDe(d,g.cod)||A.esDe(d,g.id);

  const semsPrev=sems.filter(x=>numC(x.semana||x._id)<sem)
    .sort((a,b)=>numC(b.semana||b._id)-numC(a.semana||a._id)).slice(0,4)
    .map(x=>{ try{ return JSON.parse(x.agentes||"[]"); }catch(e){ return []; } });
  const hoyISO=new Date().toISOString().slice(0,10);

  const equipos={};
  const G={vSem:0,objSem:0,mAct:0,mObj:0,cobros:0,nFacV:0,t30:0,t60:0,t90:0,t90mas:0,
    vis:0,lla:0,mEnv:0,mOk:0,mKo:0,mPend:0,mOkAnt:0,mResAnt:0,objVis:0,objLla:0,objMue:0,objMueOk:0,
    rechazos:[],sinResp:[],peor:[]};

  for(const g of gente){
    const E=equipos[g.equipo]||(equipos[g.equipo]={eq:g.equipo,jefe:jefes[g.equipo]||"",
      gente:[],vSem:0,objSem:0,mAct:0,mObj:0,cobros:0,vis:0,lla:0,mEnv:0,mOk:0,mKo:0,
      cerr:0,aus:0,sinCerrar:[]});
    // ¿Ha cerrado? informes de esa semana suyos
    const suInf=inf.filter(i=>numC(i.semana)===sem&&(A.mismo(i.agente,g.cod)||A.mismo(i.agente,g.id)));
    const ausente=suInf.some(i=>i.estado==="ausente"||i.ausente===true);
    if(ausente){ E.aus++; E.gente.push({...g,ausente:true,motivo:(suInf.find(i=>i.ausenteMotivo)||{}).ausenteMotivo||"Ausente"}); continue; }
    if(suInf.length) E.cerr++; else if(g.entrega!=="no") E.sinCerrar.push(g.nombre);

    const p={...g,vSem:0,objSem:0,mAct:0,mObj:0,cobros:0,nFacV:0,vis:0,lla:0,mEnv:0,mOk:0,semMal:0};
    const r=suyo(res,g), e2=suyo(estac,g), o2=suyo(objs,g);
    p.vSem=numC(r.ventasSem);
    p.mAct=numC(e2["act_"+mNum]);
    p.mObj=numC(o2["mes_"+mNum]);
    if(!p.mObj) p.mObj=numC(o2.objAnual)*(numC(e2["peso_"+mNum])||1/12);
    p.objSem=p.mObj?p.mObj/4.33:0;
    p.mg=(r.margenPctSem!=null&&r.margenPctSem!=="")?numC(r.margenPctSem):null;
    p.mgObj=numC(r.objetivoMargen)||null;
    p.vMes=numC(r.ventasMes)||p.mAct;
    // Politica de cobro: vencido <= 5 % de la venta de los dos ultimos meses cerrados
    p.v2m=[mNum-1,mNum-2].reduce((t,k)=>t+(k>=1?numC(e2["act_"+k]):numC(e2["mes_"+(k+12)])),0);
    p.limite=p.v2m*0.05;
    for(const ag of semsPrev){
      const f=ag.find(x=>A.mismo(x.id||x.agente,g.cod)||A.mismo(x.id||x.agente,g.id));
      if(f&&p.objSem&&numC(f.ventasSem)<p.objSem*0.5) p.semMal++; else break;
    }
    const c=suyo(cob,g);
    try{
      for(const cli of JSON.parse(c.datos||"[]")) for(const f of (cli.f||[])){
        if(!f.fv||f.fv>hoyISO) continue;
        const im=numC(f.im); p.cobros+=im; p.nFacV++;
        const dias=Math.round((Date.now()-new Date(f.fv).getTime())/86400000);
        if(dias<=30) G.t30+=im; else if(dias<=60) G.t60+=im; else if(dias<=90) G.t90+=im; else G.t90mas+=im;
        G.peor.push({cli:cli.c||"",im,dias,quien:g.nombre});
      }
    }catch(err){ p.cobros=numC(c.totalVencido); }
    for(const v of vis){
      if(v.eliminada||!enSem(fechaDocC(v))||!deQuien(v,g)) continue;
      if(/llamada|no_contesta/i.test(String(v.resultado||v.tipo||""))) p.lla++; else p.vis++;
    }
    for(const m of mues){
      if(m.eliminada||!deQuien(m,g)) continue;
      const est=String(m.estado||"").toLowerCase(), fFb=fechaC(m.fechaFeedback);
      if(enSem(fechaDocC(m))){ p.mEnv++; }
      if(enSem(fFb)){
        if(/pedido|positiv|aceptada|proyecto/.test(est)){ p.mOk++; }
        else if(/ko|negativ|rechazada/.test(est)){ E.mKo++; G.mKo++;
          G.rechazos.push({cli:m.cliente||m.clienteNombre||"(sin cliente)",prod:m.prod||m.prodNombre||"",
            motivo:m.motivo||m.nota||"Sin motivo",quien:g.nombre,eq:g.equipo}); }
      } else if(fFb&&fFb>=hace30&&fFb<lunes){
        if(/pedido|positiv|aceptada|proyecto/.test(est)){ G.mOkAnt++; G.mResAnt++; }
        else if(/ko|negativ|rechazada/.test(est)) G.mResAnt++;
      }
      if(!fFb&&!/proyecto|rechazada/.test(est)){ G.mPend++;
        const fe=fechaDocC(m); if(fe&&(lunes-fe)/86400000>21) G.sinResp.push(m.cliente||m.clienteNombre||"(sin cliente)"); }
    }
    E.gente.push(p);
    for(const k of ["vSem","objSem","mAct","mObj","cobros","vis","lla","mEnv","mOk"]) E[k]+=p[k];
    for(const k of ["vSem","objSem","mAct","mObj","cobros","nFacV","vis","lla","mEnv","mOk"]) G[k]+=p[k];
  }

  // Objetivos de actividad por equipo (mensual -> semana -> por cabeza)
  // (sep 2026) Objetivo por comercial y mes desde Administracion -> Objetivos
  // (WIKUK, Key Account, Telefonicos). Si el equipo aun tiene el antiguo, del
  // equipo entero, se reparte entre los que trabajan.
  const docPP=clave=>objEq.find(o=>UC(o.equipo)===clave&&(o.porPersona===true||o.porPersona==="true"));
  for(const E of Object.values(equipos)){
    const oe=objEq.find(o=>UC(o.equipo)===E.eq)||objEq.find(o=>UC(o.equipo)==="TODOS")||{};
    const activos=E.gente.filter(x=>!x.ausente).length||1;
    const porCabezaDe=(p,k)=>{
      const d=(p.perfil==="telefonico"&&docPP("TELEFONICO"))||docPP(E.eq);
      if(d){ const m=numC(d[k]); return m?Math.max(1,Math.round(m*7/30)):0; }
      return Math.max(0,Math.round(numC(oe[k])*7/30/activos));
    };
    const suma=k=>E.gente.filter(x=>!x.ausente).reduce((t,p)=>t+porCabezaDe(p,k),0);
    E.obj={visitas:suma("visitas"),llamadas:suma("llamadas"),muestras:suma("muestras"),muestrasOk:suma("muestrasOk")};
    G.objVis+=E.obj.visitas; G.objLla+=E.obj.llamadas; G.objMue+=E.obj.muestras; G.objMueOk+=E.obj.muestrasOk;
    const tope=x=>Math.max(0,Math.min(150,x));
    let mgS=0,mgP=0;
    E.gente.forEach(p=>{
      if(p.ausente) return;
      const c={};
      if(p.objSem) c.venta=tope(p.vSem/p.objSem*100);
      if(p.mg!=null&&p.mgObj) c.margen=tope(p.mg/p.mgObj*100);
      const act=[];
      if(porCabezaDe(p,"visitas")) act.push(tope(p.vis/porCabezaDe(p,"visitas")*100));
      if(porCabezaDe(p,"llamadas")) act.push(tope(p.lla/porCabezaDe(p,"llamadas")*100));
      if(act.length) c.actividad=act.reduce((a,b)=>a+b,0)/act.length;
      if(p.limite) c.cobro=p.cobros<=p.limite?100:tope(p.limite/p.cobros*100);
      else if(p.vMes||p.cobros) c.cobro=tope(100-(p.vMes?p.cobros/p.vMes*100:100));
      let s=0,w=0; for(const k in CEO_PESOS) if(c[k]!=null){ s+=c[k]*CEO_PESOS[k]; w+=CEO_PESOS[k]; }
      p.nota=w?Math.round(s/w):null; p.c=c;
      const sig=[];
      if(p.semMal>=2) sig.push("🔻 "+(p.semMal+1)+"ª semana seguida por debajo del 50 %");
      if(c.venta>=95&&c.actividad!=null&&c.actividad<75) sig.push("🏛 vende sin moverse: "+Math.round(c.venta)+" % venta con "+Math.round(c.actividad)+" % actividad. Cartera heredada, no prospecta");
      if(c.actividad>=90&&c.venta!=null&&c.venta<70) sig.push("🔁 mucha actividad, poca venta: "+Math.round(c.actividad)+" % actividad y "+Math.round(c.venta)+" % venta. Eficacia, no esfuerzo");
      if(p.limite&&p.cobros>p.limite) sig.push("💸 fuera de política de cobro: "+eurC(p.cobros)+" vencidos, "+Math.round(p.cobros/p.limite*100)+" % de lo permitido ("+eurC(p.limite)+")");
      else if(!p.limite&&p.cobros>=5000&&p.vMes&&p.cobros/p.vMes>0.2) sig.push("💸 cobra tarde: "+eurC(p.cobros)+" vencidos, "+p.nFacV+" facturas");
      if(p.mg!=null&&p.mgObj&&p.mg<p.mgObj-3) sig.push("📉 vende barato: margen "+decC(p.mg)+" % con objetivo "+decC(p.mgObj)+" %");
      p.sig=sig;
      if(p.mg!=null){ mgS+=p.mg*(p.vSem||1); mgP+=(p.vSem||1); }
    });
    E.mg=mgP?mgS/mgP:null;
    E.limite=E.gente.filter(x=>!x.ausente).reduce((t,p)=>t+(p.limite||0),0);
    G.limite=(G.limite||0)+E.limite;
    const conN=E.gente.filter(x=>x.nota!=null);
    E.media=conN.length?Math.round(conN.reduce((a,x)=>a+x.nota,0)/conN.length):null;
  }

  const sube=objSem.filter(o=>numC(o.semana)===sem&&numC(o.anio||anio)===anio&&!o.eliminado
    &&(o.escaladoA==="ceo"||o.escaladoA==="director"))
    .map(o=>{ const g=gente.find(x=>A.mismo(x.id,o.agente)||A.mismo(x.cod,o.agente));
      return {texto:o.texto||"",nivel:o.escaladoA,eq:o.equipo||(g&&g.equipo)||"",de:g?g.nombre:(o.agente||"")}; });

  G.peor.sort((a,b)=>b.im-a.im);
  G.sinResp=[...new Set(G.sinResp)].slice(0,6);
  return {sem,anio,mNum,G,equipos:Object.values(equipos).filter(E=>E.gente.length)
    .sort((a,b)=>b.vSem-a.vSem),sube};
}

function htmlCEO(D){
  const {G,equipos,sube,sem}=D;
  const pc=(a,b)=>b?Math.round(a/b*100):null;
  const col=p=>p==null?"#6B7684":(p>=100?"#0E7C5A":p>=80?"#B07908":"#C2263D");
  const e=escR;
  const barra=(r,o,c)=>{ const w=Math.min(100,o?Math.round(r/o*100):0);
    return `<div style="background:#EEF1F5;border-radius:99px;height:7px;overflow:hidden"><div style="background:${c};width:${w}%;height:7px;border-radius:99px"></div></div>`; };
  const h3=(t,sub)=>`<h3 style="margin:24px 0 ${sub?"2px":"8px"};font-size:14px">${t}</h3>${sub?`<div style="font-size:11.5px;color:#8A94A0;margin-bottom:8px">${sub}</div>`:""}`;
  const tile=(t,v,s,c)=>`<td style="padding:0 4px;width:33.3%;vertical-align:top"><div style="background:#F7F9FB;border-radius:10px;padding:11px 12px">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8A94A0;font-weight:700">${t}</div>
    <div style="font-size:18px;font-weight:800;margin-top:2px;color:${c}">${v}</div>
    <div style="font-size:10.5px;color:#6B7684">${s}</div></div></td>`;
  const pS=pc(G.vSem,G.objSem), pM=pc(G.mAct,G.mObj);
  const nCerr=equipos.reduce((a,E)=>a+E.cerr,0), nAus=equipos.reduce((a,E)=>a+E.aus,0);
  const sinC=equipos.flatMap(E=>E.sinCerrar);
  const flojosTot=equipos.flatMap(E=>E.gente.filter(x=>x.nota!=null&&x.nota<80));

  const porEq=`<table style="width:100%;border-collapse:collapse;font-size:13px">
    <tr>${["Equipo","Semana","Mes","Vencido"].map((t,i)=>`<th style="text-align:${i?"right":"left"};font-size:10.5px;text-transform:uppercase;color:#8A94A0;padding:0 0 6px">${t}</th>`).join("")}</tr>
    ${equipos.map(E=>{ const ps=pc(E.vSem,E.objSem), pm=pc(E.mAct,E.mObj); return `<tr>
      <td style="padding:9px 0;border-top:1px solid #EEF1F5">
        <div style="font-weight:700">${e(E.eq)}</div>
        <div style="font-size:11px;color:#8A94A0">${e(E.jefe||"sin jefe")} · ${E.cerr} cerrados${E.aus?" · "+E.aus+" ausente"+(E.aus>1?"s":""):""}${E.sinCerrar.length?` · <span style="color:#C2263D">${E.sinCerrar.length} sin cerrar</span>`:""}</div>
        <div style="font-size:11px;color:#8A94A0">👋 ${E.vis}/${E.obj.visitas} · 📞 ${E.lla}/${E.obj.llamadas} · 📦 ${E.mEnv} muestras (${E.mOk} ok, ${E.mKo} ko)</div></td>
      <td style="padding:9px 0;border-top:1px solid #EEF1F5;text-align:right;vertical-align:top"><div style="font-weight:800">${eurC(E.vSem)}</div>${ps!=null?`<div style="font-size:11px;font-weight:700;color:${col(ps)}">${ps} %</div>`:""}</td>
      <td style="padding:9px 0;border-top:1px solid #EEF1F5;text-align:right;vertical-align:top"><div style="font-weight:800">${eurC(E.mAct)}</div>${pm!=null?`<div style="font-size:11px;font-weight:700;color:${col(pm)}">${pm} %</div>`:""}</td>
      <td style="padding:9px 0;border-top:1px solid #EEF1F5;text-align:right;vertical-align:top">
        <div style="font-weight:800;color:${E.limite&&E.cobros<=E.limite?"#0E7C5A":"#C2263D"}">${eurC(E.cobros)}</div>
        ${E.limite?`<div style="font-size:11px;font-weight:700;color:${E.cobros<=E.limite?"#0E7C5A":"#C2263D"}">${Math.round(E.cobros/E.limite*100)} % perm.</div>`:""}</td></tr>`;}).join("")}
  </table>`;

  const act=[["👋 Visitas",G.vis,G.objVis],["📞 Llamadas",G.lla,G.objLla],["📦 Muestras env.",G.mEnv,G.objMue],["✅ Muestras ok",G.mOk,G.objMueOk]]
    .filter(x=>x[1]||x[2]);
  const actividad=act.length?h3("Actividad comercial","Suma de los objetivos de cada comercial (Administración → 🎯 Objetivos) llevados a la semana.")+
    `<table style="width:100%;border-collapse:collapse">${act.map(([l,r,o])=>{ const p=pc(r,o),c=col(p); return `<tr>
      <td style="padding:7px 0;font-size:12.5px;white-space:nowrap">${l}</td><td style="padding:7px 8px;width:60%">${barra(r,o,c)}</td>
      <td style="padding:7px 0;text-align:right;white-space:nowrap"><b>${r}</b>${o?`<span style="font-size:11.5px;color:#8A94A0">/${o}</span> <span style="font-size:11.5px;font-weight:700;color:${c}">${p} %</span>`:""}</td></tr>`;}).join("")}</table>`:"";

  const ranking=h3("Quién tira y quién falla, por equipo","Nota = venta 40 · margen 20 · actividad 25 · cobro 15. Y lo que el número solo no dice.")+
    equipos.map(E=>{
      const orden=E.gente.filter(x=>!x.ausente&&x.nota!=null).sort((a,b)=>b.nota-a.nota);
      if(!orden.length) return "";
      const flojos=orden.filter(x=>x.nota<80);
      const fila=(x,i)=>`<tr>
        <td style="padding:6px 0;border-top:1px solid #EEF1F5;width:22px;font-size:12px;color:#8A94A0;vertical-align:top">${i===0?"🥇":i+1}</td>
        <td style="padding:6px 0;border-top:1px solid #EEF1F5;vertical-align:top">
          <div style="font-size:12.5px;font-weight:${i===0?800:600}">${e(x.nombre)}</div>
          <div style="font-size:10.5px;color:#8A94A0">${eurC(x.vSem)}${x.mg!=null?" · mg "+decC(x.mg)+" %":""}${x.c.actividad!=null?" · act. "+Math.round(x.c.actividad)+" %":""}</div>
          ${x.sig.map(t=>`<div style="font-size:11px;color:#7A4E06;margin-top:2px">${e(t)}</div>`).join("")}</td>
        <td style="padding:6px 0 6px 10px;border-top:1px solid #EEF1F5;text-align:right;font-size:13px;font-weight:800;color:${col(x.nota)};white-space:nowrap;vertical-align:top">${x.nota} %</td></tr>`;
      return `<div style="border:1px solid #DCE1E7;border-radius:11px;padding:12px 14px;margin-bottom:11px">
        <table style="width:100%;border-collapse:collapse;margin-bottom:2px"><tr>
          <td><div style="font-size:13.5px;font-weight:800">${e(E.eq)}</div><div style="font-size:11px;color:#8A94A0">${e(E.jefe||"")}${E.mg!=null?" · margen "+decC(E.mg)+" %":""}</div></td>
          <td style="text-align:right;white-space:nowrap"><div style="font-size:15px;font-weight:800;color:${col(E.media)}">${E.media} %</div><div style="font-size:10.5px;color:#8A94A0">media del equipo</div></td></tr></table>
        <table style="width:100%;border-collapse:collapse">${orden.map(fila).join("")}</table>
        <div style="margin-top:8px;font-size:12px;padding:6px 10px;border-radius:8px;background:${flojos.length?"#FEF2F2":"#F0FDF4"};color:${flojos.length?"#C2263D":"#0E7C5A"}">
          ${flojos.length?"⚠️ Por debajo del 80 %: <b>"+flojos.map(x=>e(x.nombre)+" ("+x.nota+" %)").join(", ")+"</b>":"✅ Nadie por debajo del 80 %"}</div></div>`;
    }).join("");

  const res=G.mOk+G.mKo, conv=res?Math.round(G.mOk/res*100):null,
    convAnt=G.mResAnt?Math.round(G.mOkAnt/G.mResAnt*100):null, dif=(conv!=null&&convAnt!=null)?conv-convAnt:null;
  const cj=(n,l,c,bg)=>`<td style="padding:0 4px;width:25%"><div style="background:${bg};border-radius:9px;padding:9px 10px;text-align:center"><div style="font-size:20px;font-weight:800;color:${c};line-height:1.1">${n}</div><div style="font-size:10.5px;color:#6B7684">${l}</div></div></td>`;
  const muestras=(G.mEnv||G.mOk||G.mKo||G.mPend)?h3("Muestras")+
    `<table style="width:100%;border-collapse:separate;border-spacing:0;margin:0 -4px"><tr>${cj(G.mEnv,"enviadas","#14181F","#F7F9FB")}${cj(G.mOk,"aceptadas","#0E7C5A","#F0FDF4")}${cj(G.mKo,"rechazadas","#C2263D","#FEF2F2")}${cj(G.mPend,"sin respuesta","#B07908","#FFFBEB")}</tr></table>
    ${conv!=null?`<div style="margin-top:9px;padding:9px 12px;background:#F7F9FB;border-radius:9px"><table style="width:100%"><tr><td style="font-size:12.5px;color:#3A424E">Conversión de las resueltas</td><td style="text-align:right;font-size:14px;font-weight:800">${conv} % ${dif==null?"":dif===0?`<span style="font-size:11.5px;color:#8A94A0;font-weight:400">igual que el mes pasado</span>`:`<span style="font-size:11.5px;font-weight:700;color:${dif>0?"#0E7C5A":"#C2263D"}">${dif>0?"▲":"▼"} ${Math.abs(dif)} pts vs mes pasado</span>`}</td></tr></table></div>`:""}
    ${G.rechazos.length?`<div style="margin-top:10px"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#8A94A0;font-weight:700;margin-bottom:5px">Por qué nos han dicho que no</div>
      ${G.rechazos.slice(0,8).map(r=>`<div style="border-left:3px solid #C2263D;padding:5px 0 5px 11px;margin-bottom:7px"><div style="font-size:12.5px;font-weight:700">${e(r.cli)}${r.prod?`<span style="font-weight:400;color:#8A94A0"> · ${e(r.prod)}</span>`:""}</div><div style="font-size:12px;color:#3A424E;font-style:italic">“${e(r.motivo)}”</div><div style="font-size:11px;color:#8A94A0">${e(r.quien)} · ${e(r.eq)}</div></div>`).join("")}</div>`:""}
    ${G.sinResp.length?`<div style="margin-top:6px;font-size:12px;color:#B07908">⏳ Sin respuesta hace más de 3 semanas: ${G.sinResp.map(e).join(" · ")}</div>`:""}`:"";

  const totC=G.t30+G.t60+G.t90+G.t90mas;
  const fueraPol=equipos.flatMap(E=>E.gente.filter(p=>!p.ausente&&p.limite&&p.cobros>p.limite).map(p=>({p,eq:E.eq})))
    .sort((a,b)=>b.p.cobros/b.p.limite-a.p.cobros/a.p.limite);
  const polC=G.limite?`<div style="margin:0 0 10px;padding:9px 12px;border-radius:9px;background:${G.cobros<=G.limite?"#F0FDF4":"#FEF2F2"};color:${G.cobros<=G.limite?"#0E7C5A":"#C2263D"};font-size:12.5px">
      <b>${G.cobros<=G.limite?"✅ Dentro de política":"⚠️ Fuera de política"}</b> · ${Math.round(G.cobros/G.limite*100)} % de lo permitido (${eurC(G.limite)}, 5 % de la venta de dos meses)
      ${fueraPol.length?`<div style="margin-top:4px;color:#334155">Fuera (${fueraPol.length}): ${fueraPol.map(x=>e(x.p.nombre)+" "+Math.round(x.p.cobros/x.p.limite*100)+" %").join(" · ")}</div>`:""}</div>`:"";
  const cobros=totC?h3("Cobros pendientes",`${eurC(totC)} vencidos · ${G.nFacV} facturas`)+polC+
    `<table style="width:100%;border-collapse:collapse">${[["1–30 d",G.t30,"#B07908"],["31–60 d",G.t60,"#E0803C"],["61–90 d",G.t90,"#C2263D"],["+90 d",G.t90mas,"#8B1230"]].map(([l,v,c])=>`<tr><td style="padding:6px 0;font-size:12.5px;white-space:nowrap">${l}</td><td style="padding:6px 8px;width:70%">${barra(v,totC,c)}</td><td style="padding:6px 0;text-align:right;font-size:12.5px;font-weight:800;white-space:nowrap">${eurC(v)}</td></tr>`).join("")}</table>
    ${G.peor.length?`<div style="font-size:12px;color:#3A424E;margin-top:6px">Las mayores: ${G.peor.slice(0,3).map(x=>`${e(x.cli)} ${eurC(x.im)} (${x.dias} d, ${e(x.quien)})`).join(" · ")}</div>`:""}`:"";

  const subeH=sube.length?h3(`Lo que sube a dirección (${sube.length})`)+`<ul style="margin:0;padding-left:18px">${sube.map(o=>`<li style="margin-bottom:5px;font-size:13px">${e(o.texto)}<span style="color:#64748B"> · ${e(o.eq)}${o.de?", "+e(o.de):""}</span></li>`).join("")}</ul>`:"";

  const aten=[];
  if(flojosTot.length) aten.push(["#C2263D",`${flojosTot.length} comercial${flojosTot.length>1?"es":""} por debajo del 80 %`,flojosTot.map(x=>x.nombre+" ("+x.nota+" %)").join(" · ")]);
  if(fueraPol.length) aten.push(["#C2263D",`${fueraPol.length} fuera de la política de cobro (5 % de dos meses)`,fueraPol.map(x=>x.p.nombre+" "+Math.round(x.p.cobros/x.p.limite*100)+" %").join(" · ")]);
  if(G.t90mas) aten.push(["#C2263D",`${eurC(G.t90mas)} vencidos a más de 90 días`,"Ya no es un retraso: es riesgo de impago."]);
  if(sinC.length) aten.push(["#94A3B8",`${sinC.length} sin cerrar la semana`,sinC.join(" · ")]);
  const atencion=aten.length?h3("Lo que pide atención")+aten.map(([c,t,s])=>`<div style="border-left:3px solid ${c};padding:7px 0 7px 12px;margin-bottom:9px"><div style="font-size:13.5px;font-weight:700">${e(t)}</div><div style="font-size:12px;color:#64748B">${e(s)}</div></div>`).join(""):"";

  const html=`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:620px;margin:0 auto;color:#14181F;line-height:1.5">
    <div style="background:#14181F;color:#fff;padding:18px 20px;border-radius:12px 12px 0 0">
      <div style="font-size:11px;letter-spacing:.08em;opacity:.7;text-transform:uppercase">Dirección · cierre comercial semana ${sem}</div>
      <div style="font-size:20px;font-weight:800;margin-top:3px">Grupo Consolidado</div>
      <div style="font-size:12px;opacity:.75">${nCerr} comerciales cerrados${nAus?" · "+nAus+" ausente"+(nAus>1?"s":""):""}${sinC.length?" · "+sinC.length+" sin cerrar":""} · ${equipos.length} equipos</div>
    </div>
    <div style="border:1px solid #DCE1E7;border-top:none;border-radius:0 0 12px 12px;padding:20px">
      <table style="width:100%;border-collapse:separate;border-spacing:0;margin:0 -4px 4px"><tr>
        ${tile("Semana",eurC(G.vSem),pS!=null?pS+" % del objetivo":"sin objetivo",col(pS))}
        ${tile("Mes",eurC(G.mAct),pM!=null?pM+" % del objetivo":"sin objetivo",col(pM))}
        ${tile("Vencido",eurC(G.cobros),G.nFacV+" facturas","#C2263D")}</tr></table>
      ${h3("Por equipo")}${porEq}
      ${actividad}${ranking}${muestras}${subeH}${cobros}${atencion}
      <div style="margin-top:20px;text-align:center"><a href="${CRM}/objetivos_equipo.html?rol=ceo" style="display:inline-block;background:#14181F;color:#fff;text-decoration:none;padding:11px 26px;border-radius:9px;font-size:13.5px;font-weight:700">Abrir en el CRM</a></div>
      <p style="margin:18px 0 0;font-size:11px;color:#8A94A0;text-align:center">Informe automático del CRM · sale los sábados con el cierre de la semana.</p>
    </div></div>`;
  const subject=`📊 Cierre comercial S${sem} · ${pS!=null?pS+" % venta":eurC(G.vSem)} · mes ${pM!=null?pM+" %":eurC(G.mAct)}${flojosTot.length?" · "+flojosTot.length+" por debajo del 80 %":""}`;
  return {html,subject};
}

async function informeCEO(o){
  o=o||{};
  const hoy=new Date();
  let {sem,anio}=isoSemanaC(hoy);
  if(o.semana) sem=Number(o.semana);
  const marca=`informes_ceo/${anio}_s${sem}`;
  if(o.auto){
    // Solo sabado o domingo, y una vez por semana
    const d=hoy.getDay(); if(d!==6&&d!==0) return {ok:true,omitido:"no es fin de semana"};
    const ya=await leerDocR(marca); if(ya&&ya.enviado) return {ok:true,omitido:"ya enviado",semana:sem};
  }
  const D=await datosCEO(anio,sem);
  const {html,subject}=htmlCEO(D);
  if(o.probar) return {ok:true,semana:sem,subject,html};
  let to=o.to?[o.to]:[];
  if(!to.length){
    const us=await leerTodoC("usuarios"), pu=await leerTodoC("portal_users");
    const ceos=[...us,...pu].filter(u=>String(u.rol||"").toLowerCase()==="ceo")
      .map(u=>u.email).filter(x=>x&&!GENERICOS_R.includes(String(x).toLowerCase()));
    to=[...new Set(ceos.length?ceos:[CC_SIEMPRE])];
  }
  const env=[];
  for(const t of to) env.push(await enviarRetrasos(t,subject,html));
  if(!o.to) await guardarDocR(marca,{enviado:"si",fecha:new Date().toISOString(),semana:sem,a:to.join(",")});
  return {ok:env.every(Boolean),semana:sem,to,subject,equipos:D.equipos.length};
}

module.exports = async function handler(req, res){
  try{
    // ─────── Informe semanal de dirección, por URL ───────
    // ?ceo=semanal  (+ &probar=1 devuelve el html sin enviar, &to= para probar, &semana=39)
    if(req.method==="GET" && req.query && req.query.ceo==="semanal"){
      const sec=process.env.CRON_SECRET;
      if(sec && req.query.secret!==sec){ res.status(401).json({error:"falta el secreto"}); return; }
      const r=await informeCEO({to:req.query.to, probar:req.query.probar==="1", semana:req.query.semana});
      if(req.query.probar==="1"&&req.query.ver==="1"){ res.setHeader("Content-Type","text/html; charset=utf-8"); res.status(200).send(r.html); return; }
      res.status(200).json(req.query.probar==="1"?{...r,html:undefined,htmlLength:(r.html||"").length}:r); return;
    }

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

    // Y el informe de direccion: sabado (o domingo si el sabado fallo), una vez
    let ceo=null;
    if(String((req.query||{}).sinCeo||"")!=="1"){
      try{ ceo=await informeCEO({auto:true}); }catch(e){ ceo={error:String(e&&e.message||e)}; }
    }

    res.status(200).json({
      ok:true,
      ceo,
      revisadas: abiertas.length,
      enviadas, saltadas, sinEmail, fallidas,
      retrasos,
      errores: errores.length>0 ? errores.slice(0,5) : undefined
    });
  } catch(e){
    res.status(500).json({error:String(e&&e.message||e)});
  }
};
