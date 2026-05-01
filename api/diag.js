var https = require('https');
var FB = 'https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents';
function httpGet(u){return new Promise(function(r){https.get(u,function(s){var d='';s.on('data',function(c){d+=c;});s.on('end',function(){try{r(JSON.parse(d));}catch(e){r({});}});}).on('error',function(){r({});});});}
function pv(v){if(!v)return '';if(v.stringValue!==undefined)return v.stringValue;if(v.integerValue!==undefined)return parseInt(v.integerValue);if(v.doubleValue!==undefined)return parseFloat(v.doubleValue);if(v.booleanValue!==undefined)return v.booleanValue;if(v.arrayValue)return(v.arrayValue.values||[]).map(pv);if(v.mapValue){var o={};Object.entries(v.mapValue.fields||{}).forEach(function(e){o[e[0]]=pv(e[1]);});return o;}return '';}
function fbR(c){return httpGet(FB+'/'+c+'?pageSize=500').then(function(d){if(!d||!d.documents)return[];return d.documents.map(function(doc){var o={id:doc.name.split('/').pop()};Object.entries(doc.fields||{}).forEach(function(e){o[e[0]]=pv(e[1]);});return o;});}).catch(function(){return[];});}
module.exports = async function handler(req, res) {
  try {
    var all = await Promise.all([fbR('estrategias'),fbR('muestras'),fbR('incidencias')]);
    var est=all[0],mu=all[1],inc=all[2];
    var hoy=new Date();var ayer=new Date(hoy);ayer.setDate(hoy.getDate()-1);
    var ayerStr=ayer.toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'2-digit'});
    return res.status(200).json({
      ayerBuscando: ayerStr,
      estrategias: est.filter(function(e){return !e.eliminada;}).map(function(e){return {id:e.id,cliente:e.cliente||e.clienteNombre||'',agente:e.agente||'',estado:e.estado||'',fecha:e.fecha||'NO_FECHA',semana:e.semana||'NO_SEM'};}),
      muestras: mu.filter(function(m){return !m.eliminada;}).slice(0,10).map(function(m){return {id:m.id,prod:m.prod||m.producto||'',cliente:m.cliente||'',agente:m.agente||'',estado:m.estado||'',fecha:m.fecha||'NO_FECHA',semana:m.semana||'NO_SEM'};}),
      incidencias: inc.filter(function(i){return !i.eliminada;}).slice(0,10).map(function(i){return {id:i.id,tipo:i.tipo||'',cliente:i.clienteNombre||'',agente:i.agente||i.autor||'',estado:i.estado||'',fecha:i.fecha||'NO_FECHA',semana:i.semana||'NO_SEM'};})
    });
  } catch(err) { return res.status(200).json({ error: err.message }); }
};
