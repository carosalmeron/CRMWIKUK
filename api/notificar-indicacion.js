// /api/notificar-indicacion.js
// (v3) Recibe un LOTE de indicaciones y las agrupa por responsable:
//      envía UN email por cada vendedor con todas sus indicaciones juntas.
//      Cada email lleva en COPIA la cadena CEO > Director > Jefe del equipo.

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

function clavesUsuario(u){
  const claves=[];
  ["id","_docId","grupoAgente","nombre","username","catalogoVendedor"].forEach(k=>{
    if(u[k]) claves.push(String(u[k]).toUpperCase());
  });
  return claves;
}

function buscarUsuario(usuarios, id, nombre){
  const idU=String(id||"").toUpperCase();
  const nomU=String(nombre||"").toUpperCase();
  for(const u of usuarios){
    const claves=clavesUsuario(u);
    if((idU&&claves.indexOf(idU)>=0)||(nomU&&claves.indexOf(nomU)>=0)) return u;
  }
  return null;
}

const ICONO_TIPO = {muestra:"📦",oferta:"💰",incidencia:"🚨",tarea:"✅",hito:"🎯"};
const LBL_TIPO = {muestra:"Muestra",oferta:"Oferta",incidencia:"Incidencia",tarea:"Tarea",hito:"Hito de proyecto"};

module.exports = async function handler(req, res){
  if(req.method !== "POST"){
    res.status(405).json({error:"Método no permitido"});
    return;
  }
  try{
    const body = req.body || {};
    // Acepta un lote: { indicaciones:[...], autorMensaje, autorId }
    // o una sola indicación suelta (compatibilidad): se envuelve en lote de 1
    let indicaciones = body.indicaciones;
    if(!Array.isArray(indicaciones)){
      if(body.textoMensaje){
        indicaciones = [{
          tipoElemento: body.tipoElemento, titulo: body.titulo, cliente: body.cliente,
          responsableId: body.responsableId, responsableNombre: body.responsableNombre,
          textoMensaje: body.textoMensaje,
        }];
      } else {
        res.status(400).json({error:"Faltan indicaciones"});
        return;
      }
    }
    if(indicaciones.length===0){
      res.status(200).json({ok:true, enviados:0});
      return;
    }
    const autorMensaje = body.autorMensaje || "Un responsable";
    const autorId = body.autorId || "";

    const [usuarios, portalUsers] = await Promise.all([
      fbList("usuarios"), fbList("portal_users")
    ]);
    const todos = usuarios.concat(portalUsers);

    // Agrupar indicaciones por responsable
    const grupos = {}; // claveResp -> { responsable, items:[] }
    indicaciones.forEach(ind => {
      const resp = buscarUsuario(todos, ind.responsableId, ind.responsableNombre);
      const clave = resp ? (resp.email||resp.id||resp.nombre) : (ind.responsableNombre||"sin");
      if(!grupos[clave]) grupos[clave] = {responsable:resp, respNombre:ind.responsableNombre, items:[]};
      grupos[clave].items.push(ind);
    });

    // SMTP
    const SMTP_HOST = process.env.SMTP_HOST;
    const SMTP_USER = process.env.SMTP_USER;
    const SMTP_PASS = process.env.SMTP_PASS;
    if(!SMTP_HOST || !SMTP_USER || !SMTP_PASS){
      res.status(200).json({ok:true, enviados:0, motivo:"SMTP no configurado"});
      return;
    }
    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT||"587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: {user: SMTP_USER, pass: SMTP_PASS},
    });

    const autorUpper = String(autorMensaje).toUpperCase();
    const resultados = [];

    for(const clave in grupos){
      const g = grupos[clave];
      const resp = g.responsable;
      const emailTo = resp && resp.email ? resp.email : null;
      const equipoResp = resp ? (resp.equipo||"") : "";
      const nombreResp = resp ? (resp.nombre||resp.id) : (g.respNombre||"el responsable");

      // CC: cadena de mando
      const ccSet = new Set();
      function añadirCC(u){
        if(!u || !u.email) return;
        const claves = clavesUsuario(u);
        if(autorId && claves.indexOf(String(autorId).toUpperCase())>=0) return;
        if(autorUpper && claves.indexOf(autorUpper)>=0) return;
        if(emailTo && u.email.toLowerCase()===emailTo.toLowerCase()) return;
        ccSet.add(u.email);
      }
      todos.filter(u=>u.rol==="ceo").forEach(añadirCC);
      todos.filter(u=>u.rol==="director").forEach(añadirCC);
      todos.filter(u=>u.rol==="jefe" && (u.equipo||"")===equipoResp).forEach(añadirCC);
      const cc = Array.from(ccSet);

      if(!emailTo && cc.length===0){
        resultados.push({responsable:nombreResp, enviado:false, motivo:"sin email"});
        continue;
      }

      // Construir cuerpo con TODAS las indicaciones de este vendedor
      let bloques = "";
      g.items.forEach(ind => {
        const ico = ICONO_TIPO[ind.tipoElemento] || "📌";
        const lbl = LBL_TIPO[ind.tipoElemento] || "Elemento";
        bloques += `
          <div style="background:#F8FAFC;border-radius:10px;padding:14px;margin-bottom:10px">
            <p style="margin:0;font-size:11px;color:#64748B">${ico} ${lbl}${ind.cliente?" · "+ind.cliente:""}</p>
            <p style="margin:3px 0 8px;font-size:14px;font-weight:800;color:#0F172A">${ind.titulo||""}</p>
            <div style="border-left:3px solid #1E3A5F;padding-left:10px">
              <p style="margin:0;font-size:13px;color:#1E293B">${(ind.textoMensaje||"").replace(/</g,"&lt;")}</p>
            </div>
          </div>`;
      });

      const n = g.items.length;
      const subject = n===1
        ? `📌 Indicación de ${autorMensaje}`
        : `📌 ${n} indicaciones de ${autorMensaje}`;
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
          <h2 style="color:#1E3A5F;margin:0 0 4px">📌 ${n===1?"Tienes una indicación":"Tienes "+n+" indicaciones"}</h2>
          <p style="color:#64748B;font-size:13px;margin:0 0 18px">
            ${autorMensaje} · Centro de pendientes · CRM Grupo Consolidado
          </p>
          ${bloques}
          <p style="margin:20px 0 0">
            <a href="https://crmwikuk.vercel.app" style="background:#1E3A5F;color:#fff;padding:11px 20px;
              text-decoration:none;border-radius:8px;font-weight:700;font-size:14px">Abrir el CRM</a>
          </p>
          <p style="margin:16px 0 0;font-size:11px;color:#94A3B8">
            Responde en el hilo de seguimiento del Centro de pendientes.
            ${cc.length>0?"<br>En copia: la cadena de responsables del equipo.":""}
          </p>
        </div>
      `;

      const mailOpts = {
        from: process.env.SMTP_FROM || SMTP_USER,
        subject, html,
      };
      if(emailTo){
        mailOpts.to = emailTo;
        if(cc.length>0) mailOpts.cc = cc;
      } else {
        mailOpts.to = cc[0];
        if(cc.length>1) mailOpts.cc = cc.slice(1);
      }

      try{
        await transporter.sendMail(mailOpts);
        resultados.push({responsable:nombreResp, enviado:true, to:mailOpts.to, n});
      }catch(e){
        resultados.push({responsable:nombreResp, enviado:false, error:e.message});
      }
    }

    res.status(200).json({ok:true, enviados:resultados.filter(r=>r.enviado).length, resultados});
  }catch(e){
    console.error(e);
    res.status(500).json({error: e.message || "Error interno"});
  }
};
