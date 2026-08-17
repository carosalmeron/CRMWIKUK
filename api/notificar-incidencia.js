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

// Carga las 3 colecciones UNA vez por invocación
async function cargarDatos(){
  const [departamentos, portal, usuarios] = await Promise.all([
    listColeccion("departamentos"),
    listColeccion("portal_users"),
    listColeccion("usuarios"),
  ]);
  return {departamentos, portal, usuarios};
}

function cuentaValida(u){
  return u && !u.duplicadaDe && u.activo!==false && !u._legacy;
}

// Todas las cuentas (portal + usuarios) de una persona por id, deduplicadas
function emailDeCuenta(datos, cuentaId){
  if(!cuentaId) return null;
  const idN=String(cuentaId).toLowerCase();
  const coincide=u=>{
    if(!cuentaValida(u)) return false;
    return [u.id,u._id,u.crmId,u.perfilCRM,u.username]
      .some(k=>k&&String(k).toLowerCase()===idN);
  };
  // usuarios primero (ficha CRM), luego portal (credenciales suelen llevar email)
  let m=datos.usuarios.find(u=>coincide(u)&&u.email);
  if(m) return m.email;
  m=datos.portal.find(u=>coincide(u)&&u.email);
  return m?m.email:null;
}

// Destinatarios de una tipología según el organigrama:
// { directos:[emails], escalado:[emails del depto padre] }
function destinatariosDe(datos, tipologia){
  const directos=new Set(), escalado=new Set();
  const addD=e=>{ if(e) directos.add(String(e).toLowerCase()); };
  const addE=e=>{ if(e) escalado.add(String(e).toLowerCase()); };

  // 1. Departamento del organigrama cuya lista `tipologias` incluye este tipo
  const dep=datos.departamentos.find(d=>{
    if(d.activo===false) return false;
    const tips=(d.tipologias||[]).map(t=>String(t).toLowerCase());
    return tips.indexOf(tipologia)>=0;
  });
  if(dep){
    (dep.responsableIds||[]).forEach(rid=>addD(emailDeCuenta(datos,rid)));
    // Escalado: responsables del departamento PADRE (excepto dirección)
    if(dep.padre && dep.padre!=="direccion"){
      const padre=datos.departamentos.find(d=>d._id===dep.padre||d.id===dep.padre);
      if(padre&&padre.activo!==false){
        (padre.responsableIds||[]).forEach(rid=>addE(emailDeCuenta(datos,rid)));
      }
    }
  }

  // 2. Compatibilidad: cualquier ficha con campo `tipologia` coincidente
  //    o con id legacy resp_* (comportamiento anterior, ahora aditivo)
  [datos.portal, datos.usuarios].forEach(col=>{
    col.forEach(u=>{
      if(!cuentaValida(u)||!u.email) return;
      const tip=String(u.tipologia||ID_A_TIPOLOGIA[u.id||u._id]||"").toLowerCase();
      if(tip===tipologia) addD(u.email);
    });
  });

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

  const base=process.env.VERCEL_URL?("https://"+process.env.VERCEL_URL):"https://crmwikuk.vercel.app";
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

      const tipologia = TIPO_A_TIPOLOGIA[String(inc.tipo||"").toLowerCase()];
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

    res.status(200).json({
      ok:true,
      revisadas: abiertas.length,
      enviadas, saltadas, sinEmail, fallidas,
      errores: errores.length>0 ? errores.slice(0,5) : undefined
    });
  } catch(e){
    res.status(500).json({error:String(e&&e.message||e)});
  }
};
