// /api/notificar-indicacion.js
// Envía un email al responsable de un elemento (muestra, oferta, incidencia, tarea, hito)
// cuando alguien le deja una indicación en el hilo de seguimiento del Centro de Pendientes.

const FB = "https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents";

function fsToObj(doc){
  if(!doc||!doc.fields) return null;
  const o={};
  for(const k in doc.fields){
    const v=doc.fields[k];
    if(v.stringValue!==undefined)o[k]=v.stringValue;
    else if(v.integerValue!==undefined)o[k]=parseInt(v.integerValue);
    else if(v.doubleValue!==undefined)o[k]=parseFloat(v.doubleValue);
    else if(v.booleanValue!==undefined)o[k]=v.booleanValue;
    else if(v.timestampValue!==undefined)o[k]=v.timestampValue;
    else if(v.nullValue!==undefined)o[k]=null;
    else if(v.arrayValue&&v.arrayValue.values){
      o[k]=v.arrayValue.values.map(x=>{
        if(x.stringValue!==undefined)return x.stringValue;
        if(x.integerValue!==undefined)return parseInt(x.integerValue);
        if(x.mapValue)return fsToObj({fields:x.mapValue.fields});
        return x;
      });
    } else if(v.mapValue)o[k]=fsToObj({fields:v.mapValue.fields});
  }
  return o;
}

async function fbList(col){
  let docs=[], pageToken=null;
  do{
    const url=`${FB}/${col}?pageSize=300${pageToken?`&pageToken=${pageToken}`:""}`;
    const r=await fetch(url);
    if(!r.ok) break;
    const j=await r.json();
    if(j.documents){
      j.documents.forEach(d=>{
        const o=fsToObj(d);
        o._docId=d.name.split("/").pop();
        docs.push(o);
      });
    }
    pageToken=j.nextPageToken;
  }while(pageToken);
  return docs;
}

// Resolver el email del responsable a partir de su id/nombre
function buscarEmail(usuarios, responsableId, responsableNombre){
  if(!responsableId && !responsableNombre) return null;
  const idU = String(responsableId||"").toUpperCase();
  const nomU = String(responsableNombre||"").toUpperCase();
  for(const u of usuarios){
    const claves = [];
    ["id","_docId","grupoAgente","nombre","username","catalogoVendedor"].forEach(k=>{
      if(u[k]) claves.push(String(u[k]).toUpperCase());
    });
    if(claves.indexOf(idU)>=0 || (nomU && claves.indexOf(nomU)>=0)){
      if(u.email) return {email:u.email, nombre:u.nombre||u.id};
    }
  }
  return null;
}

module.exports = async function handler(req, res){
  if(req.method !== "POST"){
    res.status(405).json({error:"Método no permitido"});
    return;
  }
  try{
    const body = req.body || {};
    const {tipoElemento, titulo, cliente, responsableId, responsableNombre,
           autorMensaje, textoMensaje} = body;

    if(!textoMensaje){
      res.status(400).json({error:"Falta textoMensaje"});
      return;
    }

    // Buscar email del responsable
    const [usuarios, portalUsers] = await Promise.all([
      fbList("usuarios"), fbList("portal_users")
    ]);
    const todos = usuarios.concat(portalUsers);
    const dest = buscarEmail(todos, responsableId, responsableNombre);

    if(!dest || !dest.email){
      // No hay email — no es error, simplemente no se envía
      res.status(200).json({ok:true, enviado:false, motivo:"responsable sin email"});
      return;
    }

    // Configurar SMTP
    const SMTP_HOST = process.env.SMTP_HOST;
    const SMTP_USER = process.env.SMTP_USER;
    const SMTP_PASS = process.env.SMTP_PASS;
    if(!SMTP_HOST || !SMTP_USER || !SMTP_PASS){
      res.status(200).json({ok:true, enviado:false, motivo:"SMTP no configurado"});
      return;
    }
    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT||"587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: {user: SMTP_USER, pass: SMTP_PASS},
    });

    const iconoTipo = {
      muestra:"📦", oferta:"💰", incidencia:"🚨", tarea:"✅", hito:"🎯"
    }[tipoElemento] || "📌";
    const tipoLbl = {
      muestra:"Muestra", oferta:"Oferta", incidencia:"Incidencia",
      tarea:"Tarea", hito:"Hito de proyecto"
    }[tipoElemento] || "Elemento";

    const subject = `📌 Indicación sobre ${tipoLbl.toLowerCase()}: ${cliente||titulo||""}`;
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#1E3A5F;margin:0 0 4px">📌 Tienes una indicación pendiente</h2>
        <p style="color:#64748B;font-size:13px;margin:0 0 18px">Centro de pendientes · CRM Grupo Consolidado</p>

        <div style="background:#F8FAFC;border-radius:10px;padding:14px;margin-bottom:14px">
          <p style="margin:0;font-size:12px;color:#64748B">${iconoTipo} ${tipoLbl}</p>
          <p style="margin:4px 0 0;font-size:15px;font-weight:800;color:#0F172A">${titulo||""}</p>
          ${cliente?`<p style="margin:2px 0 0;font-size:13px;color:#475569">${cliente}</p>`:""}
        </div>

        <div style="border-left:4px solid #1E3A5F;background:#EFF6FF;border-radius:0 8px 8px 0;padding:12px 14px">
          <p style="margin:0;font-size:11px;font-weight:700;color:#1E40AF">${autorMensaje||"Un responsable"} te indica:</p>
          <p style="margin:6px 0 0;font-size:14px;color:#1E293B">${(textoMensaje||"").replace(/</g,"&lt;")}</p>
        </div>

        <p style="margin:20px 0 0">
          <a href="https://crmwikuk.vercel.app" style="background:#1E3A5F;color:#fff;padding:11px 20px;
            text-decoration:none;border-radius:8px;font-weight:700;font-size:14px">Abrir el CRM</a>
        </p>
        <p style="margin:16px 0 0;font-size:11px;color:#94A3B8">
          Responde directamente en el hilo de seguimiento del Centro de pendientes.
        </p>
      </div>
    `;

    await transporter.sendMail({
      from: process.env.SMTP_FROM || SMTP_USER,
      to: dest.email,
      subject,
      html,
    });

    res.status(200).json({ok:true, enviado:true, a:dest.email});
  }catch(e){
    console.error(e);
    res.status(500).json({error: e.message || "Error interno"});
  }
};
