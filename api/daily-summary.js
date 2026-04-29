module.exports = async function handler(req, res) {
try {
var https = require('https');
var FB = 'https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents';
var d = await new Promise(function(r){https.get(FB+'/visitas?pageSize=500',function(s){var data='';s.on('data',function(c){data+=c;});s.on('end',function(){r(JSON.parse(data));});}).on('error',function(){r({});});});
var docs = (d.documents||[]).map(function(doc){var f=doc.fields||{};return {ag:(f.agente||f.agenteId||{}).stringValue||'',cli:(f.clienteNombre||f.cliente||{}).stringValue||'',sem:(f.semana||{}).integerValue||'',res:(f.resultado||{}).stringValue||'',nota:(f.notas||f.nota||{}).stringValue||''};});
var sem = Math.ceil(((new Date()-new Date(new Date().getFullYear(),0,1))/86400000+new Date(new Date().getFullYear(),0,1).getDay()+1)/7);
var azarco = docs.filter(function(v){return (v.ag||'').toUpperCase()==='AZARCO'||v.ag==='ik4';});
var azSem = azarco.filter(function(v){return parseInt(v.sem)===sem;});
return res.status(200).json({semana:sem,visitas_total:docs.length,azarco_total:azarco.length,azarco_semana:azSem.length,detalle:azSem.map(function(v){return v.cli+' | '+v.res+' | '+v.nota;})});
}catch(e){return res.status(200).json({error:e.message});}
};
