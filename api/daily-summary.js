module.exports = async function handler(req, res) {
try {
var https = require('https');
var FB = 'https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents';
var d = await new Promise(function(r){https.get(FB+'/portal_users?pageSize=500',function(s){var data='';s.on('data',function(c){data+=c;});s.on('end',function(){r(JSON.parse(data));});}).on('error',function(){r({});});});
var users = (d.documents||[]).map(function(doc){var f=doc.fields||{};return {id:doc.name.split('/').pop(),nombre:(f.nombre||{}).stringValue||'',rol:(f.rol||{}).stringValue||'',vendor:(f.catalogoVendedor||{}).stringValue||'',email:(f.email||{}).stringValue||'',equipo:(f.equipo||{}).stringValue||''};});
var agentes = users.filter(function(u){return u.rol==='crm_agente'||u.rol==='agente';});
return res.status(200).json({total:users.length,agentes:agentes.length,detalle:agentes.map(function(u){return u.nombre+' | rol:'+u.rol+' | vendor:'+u.vendor+' | email:'+u.email;})});
}catch(e){return res.status(200).json({error:e.message});}
};
