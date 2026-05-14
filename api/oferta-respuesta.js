// /api/oferta-respuesta.js
// Recibe la respuesta del cliente desde la página pública de oferta
// La guarda en oferta.respuestasCliente[lineaId] (o lineas múltiples si tipo=global)
// Estado intermedio: respuesta_cliente_pendiente_validacion
// Notifica al agente por email

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
        if(x.doubleValue!==undefined)return parseFloat(x.doubleValue);
        if(x.mapValue)return fsToObj({fields:x.mapValue.fields});
        return x;
      });
    } else if(v.mapValue)o[k]=fsToObj({fields:v.mapValue.fields});
  }
  return o;
}

function objToFs(obj){
  const fields = {};
  for(const k in obj){
    const v = obj[k];
    if(v === null || v === undefined) fields[k] = {nullValue: null};
    else if(typeof v === "string") fields[k] = {stringValue: v};
    else if(typeof v === "boolean") fields[k] = {booleanValue: v};
    else if(typeof v === "number"){
      if(Number.isInteger(v)) fields[k] = {integerValue: String(v)};
      else fields[k] = {doubleValue: v};
    }
    else if(Array.isArray(v)){
      fields[k] = {arrayValue: {values: v.map(x => {
        if(typeof x === "string") return {stringValue: x};
        if(typeof x === "number"){
          if(Number.isInteger(x)) return {integerValue: String(x)};
          return {doubleValue: x};
        }
        if(typeof x === "boolean") return {booleanValue: x};
        if(x && typeof x === "object") return {mapValue: {fields: objToFs(x).fields}};
        return {stringValue: String(x)};
      })}};
    }
    else if(typeof v === "object") fields[k] = {mapValue: {fields: objToFs(v).fields}};
  }
  return {fields};
}

async function fbGet(col, id){
  const r = await fetch(`${FB}/${col}/${id}`);
  if(!r.ok) return null;
  const j = await r.json();
  return fsToObj(j);
}

async function fbPatch(col, id, obj, mask){
  // (v2) Si se pasa mask, usar updateMask para actualizar solo esos campos
  // Si no, escribir documento completo (caller debe pasar TODO el documento)
  let url = `${FB}/${col}/${id}`;
  if(mask && mask.length > 0){
    const params = mask.map(f => "updateMask.fieldPaths=" + encodeURIComponent(f)).join("&");
    url += "?" + params;
  }
  const r = await fetch(url, {
    method: "PATCH",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(objToFs(obj))
  });
  if(!r.ok) throw new Error("Firebase patch failed: " + await r.text());
  return await r.json();
}

async function enviarNotificacionEmail(oferta, payload){
  // Buscar email del agente
  try{
    // Intentar buscar en portal_users por nombre/id
    if(!oferta.agenteEmail){
      // No tenemos email, intentar buscar en USUARIOS hardcoded por agenteNombre
      return;
    }
    const SMTP_HOST = process.env.SMTP_HOST;
    const SMTP_USER = process.env.SMTP_USER;
    const SMTP_PASS = process.env.SMTP_PASS;
    const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
    if(!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return;

    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: 465,
      secure: true,
      auth: {user: SMTP_USER, pass: SMTP_PASS}
    });

    const estadoLbl = payload.estado==="pedido"?"✅ HIZO PEDIDO"
                    : payload.estado==="caro"?"💸 VAMOS CAROS"
                    : "🔇 NO INTERESA";
    const subject = `[Oferta cliente] ${oferta.clienteNombre || "Cliente"} → ${estadoLbl}`;
    const lineaTxt = payload.tipo==="global"
      ? `Toda la oferta`
      : (function(){
          const l = (oferta.lineas||[]).find(x=>x.id===payload.lineaId);
          return l ? (l.producto + (l.calibre?" · "+l.calibre:"")) : "Línea";
        })();

    let body = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
      <h2 style="color:#1E3A5F;margin:0 0 10px">📨 Respuesta de cliente a oferta</h2>
      <p style="color:#64748B;font-size:13px;margin:0 0 16px">${oferta.clienteNombre||""}</p>
      <div style="background:#F8FAFC;border-radius:10px;padding:14px;margin:10px 0">
        <p style="margin:0;font-size:14px"><strong>${lineaTxt}</strong></p>
        <p style="margin:6px 0 0;font-size:16px;font-weight:800">${estadoLbl}</p>
      </div>`;
    if(payload.contraoferta) body += `<p>💰 <strong>Contraoferta:</strong> ${payload.contraoferta} €</p>`;
    if(payload.cantidad) body += `<p>📦 <strong>Cantidad:</strong> ${payload.cantidad}</p>`;
    if(payload.fechaEntrega) body += `<p>📅 <strong>Fecha entrega:</strong> ${payload.fechaEntrega}</p>`;
    if(payload.comentario) body += `<p>💬 <em>"${payload.comentario}"</em></p>`;
    body += `<p style="margin-top:20px;padding:12px;background:#FEF3C7;border-radius:8px;font-size:13px">
      ⚠️ Esta respuesta está pendiente de tu validación en el CRM antes de cerrar la oferta.
      </p>
      <p style="margin-top:20px"><a href="https://crmwikuk.vercel.app" style="background:#1E3A5F;color:#fff;padding:10px 18px;text-decoration:none;border-radius:8px;font-weight:700">Abrir CRM</a></p>
    </div>`;

    await transporter.sendMail({
      from: SMTP_FROM,
      to: oferta.agenteEmail,
      subject,
      html: body
    });
  }catch(e){
    console.error("Email fallido:", e.message);
  }
}

module.exports = async function handler(req, res){
  if(req.method !== "POST"){
    res.status(405).json({error: "Método no permitido"});
    return;
  }
  try{
    const body = req.body || {};
    const {ofertaId, token, tipo, lineaId, estado, motivo, contraoferta, cantidad, fechaEntrega, comentario} = body;

    if(!ofertaId || !estado){
      res.status(400).json({error: "Faltan datos: ofertaId, estado"});
      return;
    }
    if(!["pedido","caro","no_interesa"].includes(estado)){
      res.status(400).json({error: "Estado inválido"});
      return;
    }

    // Cargar oferta
    const oferta = await fbGet("ofertas", ofertaId);
    if(!oferta){
      res.status(404).json({error: "Oferta no encontrada"});
      return;
    }
    if(oferta.eliminada){
      res.status(400).json({error: "Oferta cancelada"});
      return;
    }
    // Validar token
    if(oferta.tokenCliente && oferta.tokenCliente !== token){
      res.status(403).json({error: "Token inválido"});
      return;
    }

    // Construir respuesta
    const ahora = new Date().toISOString();
    const respuestasCliente = oferta.respuestasCliente || {};
    const respBase = {
      estado,
      contraoferta: contraoferta || "",
      cantidad: cantidad || "",
      fechaEntrega: fechaEntrega || "",
      comentario: comentario || "",
      motivo: motivo || "",
      fechaRespuesta: ahora,
      validada: false, // pendiente de validación del agente
    };

    if(tipo === "global"){
      // Aplicar a todas las líneas pendientes
      (oferta.lineas||[]).forEach(l => {
        const r = respuestasCliente[l.id];
        if(!r || !r.estado){
          respuestasCliente[l.id] = Object.assign({}, respBase, {lineaId: l.id});
        }
      });
    } else {
      if(!lineaId){
        res.status(400).json({error: "Falta lineaId para respuesta tipo=línea"});
        return;
      }
      respuestasCliente[lineaId] = Object.assign({}, respBase, {lineaId});
    }

    // Añadir entrada al historial de seguimientos
    const seguimientos = (oferta.seguimientos || []).slice();
    const accionLbl = estado==="pedido"?"📨 Cliente: HIZO PEDIDO"
                    : estado==="caro"?"📨 Cliente: VAMOS CAROS"
                    : "📨 Cliente: NO INTERESA";
    seguimientos.push({
      accion: accionLbl,
      fecha: new Date().toLocaleDateString("es-ES"),
      por: "Cliente (respuesta web)",
      nota: comentario || "",
      respuestaCliente: true,
      pendienteValidacion: true,
    });

    // (v2) Actualizar oferta — escribir documento COMPLETO para evitar pérdida de campos
    // Alternativa: usar updateMask. Optamos por documento completo para máxima seguridad.
    const ofertaCompleta = Object.assign({}, oferta, {
      respuestasCliente,
      seguimientos,
      hayRespuestaPendienteValidacion: true,
      ultimaRespuestaCliente: ahora,
    });
    // Limpiar campos internos que no deben volver a guardarse si vienen del fetch
    delete ofertaCompleta._docId;

    await fbPatch("ofertas", ofertaId, ofertaCompleta);

    // Notificar al agente por email (best-effort, no bloquea respuesta)
    enviarNotificacionEmail(ofertaCompleta, body).catch(()=>{});

    res.status(200).json({ok: true});
  }catch(e){
    console.error(e);
    res.status(500).json({error: e.message || "Error interno"});
  }
};
