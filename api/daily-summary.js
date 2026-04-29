module.exports = async function handler(req, res) {
try {
var https = require('https');
var FB = 'https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents';
var d = await new Promise(function(r){https.get(FB+'/visitas?pageSize=500',function(s){var data='';s.on('data',function(c){data+=c;});s.on('end',function(){r(JSON.parse(data));});}).on('error',function(){r({});});});
var docs = (d.documents||[]).map(function(doc){var f=doc.fields||{};var semRaw=f.semana||{};return {ag:(f.agente||{}).stringValue||(f.agenteId||{}).stringValue||'',cli:(f.clienteNombre||{}).stringValue||(f.cliente||{}).stringValue||'',semRaw:JSON.stringify(semRaw),semStr:(semRaw.stringValue||''),semInt:(semRaw.integerValue||''),res:(f.resultado||{}).stringValue||'',nota:(f.notas||{}).stringValue||(f.nota||{}).stringValue||''};});
var azarco = docs.filter(function(v){return (v.ag||'').toUpperCase()==='AZARCO'||v.ag==='ik4';});
return res.status(200).json({semana_actual:18,azarco_total:azarco.length,visitas:azarco.map(function(v){return v.cli+' | sem:'+v.semStr+'/'+v.semInt+' | raw:'+v.semRaw+' | '+v.res;})});
}catch(e){return res.status(200).json({error:e.message});}
};
