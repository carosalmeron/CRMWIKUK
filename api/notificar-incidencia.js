// api/notificar-incidencia.js
// Envía email al responsable de tipología cuando se crea una incidencia
// y también sirve como worker para los recordatorios diarios.
//
// POST inmediato: { incidenciaId } → notifica al responsable de esa incidencia
// GET (cron):    sin params       → procesa todas las abiertas y envía recordatorios

const FB = "https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents";

function fsToObj(doc){
  if(!doc||!doc.fields) return null;
  const o={};
  for(const k in doc.fields){
    const v=doc.fields[k];
    if(v.stringValue!==undefined) o[k]=v.stringValue;
    else if(v.integerValue!==undefined) o[k]=parseInt(v.integerValue);
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

// Mapeo id de cuenta → tipología (para portal_users que solo tienen rol crm_jefe)
const ID_A_TIPOLOGIA = {
  resp_cal: "calidad",
  resp_log: "logistica",
  resp_adm: "administracion",
  resp_stk: "stock",
  resp_prd: "produccion",
  resp_id:  "id",
  resp_coord: "coordinacion"
};

// Encuentra el email del responsable para una tipología
async function emailResponsable(tipologia){
  if(!tipologia) return null;
  // 1. Buscar en portal_users por id resp_xxx o por campo tipologia
  const portal = await listColeccion("portal_users");
  let resp = portal.find(u=>{
    const tip = u.tipologia || ID_A_TIPOLOGIA[u.id||u._id];
    return tip===tipologia && u.email;
  });
  if(resp&&resp.email) return resp.email;
  // 2. Fallback: colección usuarios
  const usuarios = await listColeccion("usuarios");
  resp = usuarios.find(u=>{
    const tip = u.tipologia || ID_A_TIPOLOGIA[u.id||u._id];
    return tip===tipologia && u.email;
  });
  return resp&&resp.email ? resp.email : null;
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

// Construye y envía un email
async function enviarEmail(to, subject, text){
  if(!to) return {ok:false, error:"sin destinatario"};
  const base=process.env.VERCEL_URL?("https://"+process.env.VERCEL_URL):"https://crmwikuk.vercel.app";
  const r=await fetch(base+"/api/send-email",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({to:[to], subject, text})
  });
  return {ok:r.ok, status:r.status};
}

// Construye cuerpo y asunto según es nuevo o recordatorio
function construirEmail(inc, dias){
  const tipo = LABEL_TIPO[TIPO_A_TIPOLOGIA[String(inc.tipo||"").toLowerCase()]] || inc.tipo || "—";
  const cliente = inc.cliente || inc.clienteNombre || "—";
  const prio = (inc.prioridad||"media").toLowerCase();
  const prioEtiq = prio==="alta"||prio==="urgente" ? "🔴 ALTA" : prio==="baja" ? "⚪ Baja" : "🟡 Media";
  const linkCRM = "https://crmwikuk.vercel.app/";

  let subject, intro;
  if(dias===0){
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

module.exports = async function handler(req, res){
  try{
    // ─────── MODO 1: POST inmediato al crear una incidencia ───────
    if(req.method==="POST"){
      const {incidenciaId} = req.body||{};
      if(!incidenciaId){ res.status(400).json({error:"Falta incidenciaId"}); return; }
      const inc = await getDoc("incidencias", incidenciaId);
      if(!inc){ res.status(404).json({error:"Incidencia no encontrada"}); return; }
      const tipologia = TIPO_A_TIPOLOGIA[String(inc.tipo||"").toLowerCase()];
      if(!tipologia){ res.status(200).json({ok:true, skipped:"tipo no mapeado a tipología"}); return; }
      const email = await emailResponsable(tipologia);
      if(!email){ res.status(200).json({ok:true, skipped:"sin email configurado para "+tipologia}); return; }
      const {subject, body} = construirEmail(inc, 0);
      const send = await enviarEmail(email, subject, body);
      if(send.ok){
        // Marcar que se envió aviso inicial
        await setCampo("incidencias", incidenciaId, "ultimoAvisoFecha", new Date().toISOString());
        await setCampo("incidencias", incidenciaId, "ultimoAvisoTipo", "creacion");
      }
      res.status(200).json({ok:send.ok, to:email});
      return;
    }

    // ─────── MODO 2: GET (cron diario) — repasar y enviar recordatorios ───────
    const incidencias = await listColeccion("incidencias");
    const hoy = new Date();
    const hoyISO = hoy.toISOString().substring(0,10); // yyyy-mm-dd

    const abiertas = incidencias.filter(i=>{
      if(i.eliminada) return false;
      const e = i.estado||"abierta";
      return e==="abierta"; // solo abiertas: en_proceso, resuelta, cerrada se excluyen
    });

    let enviadas=0, saltadas=0, sinEmail=0;
    for(const inc of abiertas){
      const dias = diasDesde(inc.fecha);
      if(dias<1) continue; // 0 días = se acaba de crear, ya tiene su email inicial

      // No enviar más de uno por día — si ya se envió hoy, saltar
      const ultimoISO = (inc.ultimoAvisoFecha||"").substring(0,10);
      if(ultimoISO===hoyISO){ saltadas++; continue; }

      const tipologia = TIPO_A_TIPOLOGIA[String(inc.tipo||"").toLowerCase()];
      if(!tipologia){ saltadas++; continue; }
      const email = await emailResponsable(tipologia);
      if(!email){ sinEmail++; continue; }

      const {subject, body} = construirEmail(inc, dias);
      const send = await enviarEmail(email, subject, body);
      if(send.ok){
        await setCampo("incidencias", inc._id, "ultimoAvisoFecha", new Date().toISOString());
        await setCampo("incidencias", inc._id, "ultimoAvisoTipo", "recordatorio_d"+dias);
        enviadas++;
      }
    }

    res.status(200).json({
      ok:true,
      revisadas: abiertas.length,
      enviadas, saltadas, sinEmail
    });
  } catch(e){
    res.status(500).json({error:String(e&&e.message||e)});
  }
};
