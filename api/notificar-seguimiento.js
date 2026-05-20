// api/notificar-seguimiento.js
// Recibe POST con {tipo, muestraId, token, texto, subtipo} y envía email a responsables

const FB="https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents";

function fsToObj(doc){
  if(!doc||!doc.fields) return null;
  const o={};
  for(const k in doc.fields){
    const v=doc.fields[k];
    if(v.stringValue!==undefined)o[k]=v.stringValue;
    else if(v.integerValue!==undefined)o[k]=parseInt(v.integerValue);
    else if(v.booleanValue!==undefined)o[k]=v.booleanValue;
    else if(v.arrayValue&&v.arrayValue.values){
      o[k]=v.arrayValue.values.map(x=>{
        if(x.stringValue!==undefined)return x.stringValue;
        if(x.mapValue){
          const sub={};
          for(const sk in x.mapValue.fields){
            const sv=x.mapValue.fields[sk];
            if(sv.stringValue!==undefined) sub[sk]=sv.stringValue;
            else if(sv.integerValue!==undefined) sub[sk]=parseInt(sv.integerValue);
            else if(sv.booleanValue!==undefined) sub[sk]=sv.booleanValue;
          }
          return sub;
        }
        return x;
      });
    }
  }
  return o;
}

module.exports = async function handler(req,res){
  if(req.method!=="POST"){ res.status(405).json({error:"Method not allowed"}); return; }
  try{
    const {tipo,muestraId,token,texto,subtipo}=req.body||{};
    if(!muestraId||!token){ res.status(400).json({error:"Faltan parámetros"}); return; }

    // Leer la muestra para validar token y obtener responsables
    const r=await fetch(FB+"/muestras/"+encodeURIComponent(muestraId));
    if(!r.ok){ res.status(404).json({error:"Muestra no encontrada"}); return; }
    const j=await r.json();
    const m=fsToObj(j);
    if(!m||m.tokenCliente!==token){ res.status(403).json({error:"Token inválido"}); return; }

    // Destinatarios: responsables + email del agente (si está en USUARIOS — no lo tenemos aquí, así que usamos solo responsables)
    const dests=(m.responsables||[]).map(r=>typeof r==="string"?r:r.email).filter(Boolean);
    if(dests.length===0){ res.status(200).json({ok:true,sent:0,note:"sin responsables"}); return; }

    // Construir asunto y cuerpo según tipo
    const cliente=m.cliente||m.clienteNombre||"cliente";
    const prod=m.prod||m.producto||"muestra";
    const linkCRM="https://crmwikuk.vercel.app/"; // TODO: link directo a la muestra cuando tengamos rewrite
    let subject, body;

    if(tipo==="mensaje"){
      subject="💬 Nuevo mensaje del cliente — "+cliente+" / "+prod;
      body="El cliente "+cliente+" ha enviado un mensaje sobre la muestra «"+prod+"»:\n\n"+
        "« "+(texto||"")+" »\n\nResponde desde el CRM:\n"+linkCRM;
    } else if(tipo==="asistencia"){
      subject="🚨 ASISTENCIA TÉCNICA solicitada — "+cliente+" / "+prod;
      body="⚠️ El cliente "+cliente+" ha solicitado asistencia técnica sobre la muestra «"+prod+"».\n\n"+
        (texto?"Detalles: « "+texto+" »\n\n":"")+
        "Contacta con él lo antes posible.\n\nCRM: "+linkCRM;
    } else if(tipo==="cierre_sugerido"){
      const tip=subtipo==="ok"?"✅ con éxito":"❌ sin éxito";
      subject="📋 El cliente sugiere cerrar la muestra "+tip+" — "+cliente+" / "+prod;
      body="El cliente "+cliente+" ha sugerido cerrar la muestra «"+prod+"» "+tip+".\n\n"+
        "Comentario: « "+(texto||"")+" »\n\n"+
        "Revisa la sugerencia en el CRM y confirma o rechaza:\n"+linkCRM;
    } else {
      subject="📋 Actualización del seguimiento — "+cliente;
      body="Hay novedades en la muestra «"+prod+"» del cliente "+cliente+".\n\nCRM: "+linkCRM;
    }

    // Reusar el endpoint send-email existente (más simple que duplicar SMTP)
    const base=process.env.VERCEL_URL?("https://"+process.env.VERCEL_URL):"https://crmwikuk.vercel.app";
    const send=await fetch(base+"/api/send-email",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({to:dests,subject:subject,text:body})
    });
    if(!send.ok){
      const errTxt=await send.text();
      res.status(500).json({error:"Error al enviar email",detail:errTxt});
      return;
    }
    res.status(200).json({ok:true,sent:dests.length});
  } catch(e){
    res.status(500).json({error:String(e&&e.message||e)});
  }
};
