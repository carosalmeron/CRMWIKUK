module.exports = async function handler(req, res) {
try {
var https=require('https');
var FB='https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents';
function httpGet(u){return new Promise(function(r){https.get(u,function(s){var d='';s.on('data',function(c){d+=c;});s.on('end',function(){try{r(JSON.parse(d));}catch(e){r({});}});}).on('error',function(){r({});});});}
function pv(v){if(!v)return '';if(v.stringValue!==undefined)return v.stringValue;if(v.integerValue!==undefined)return parseInt(v.integerValue);if(v.doubleValue!==undefined)return parseFloat(v.doubleValue);if(v.booleanValue!==undefined)return v.booleanValue;if(v.arrayValue)return(v.arrayValue.values||[]).map(pv);if(v.mapValue){var o={};Object.entries(v.mapValue.fields||{}).forEach(function(e){o[e[0]]=pv(e[1]);});return o;}return '';}
async function fbR(c){try{var d=await httpGet(FB+'/'+c+'?pageSize=500');if(!d||!d.documents)return[];return d.documents.map(function(doc){var o={id:doc.name.split('/').pop()};Object.entries(doc.fields||{}).forEach(function(e){o[e[0]]=pv(e[1]);});return o;});}catch(e){return[];}}
var ID_MAP={ik1:'CARLOSG',ik2:'RICARDO',ik3:'RPIEDRA',ik4:'AZARCO',jl:'JLGARCIA',w1:'CARLOSG',w2:'TROUILLE',ANTONIO:'AZARCO',AGUSTIN:'ACRUZ'};
function resolveVendor(ag){var u=(ag||'').toUpperCase();return ID_MAP[ag]||ID_MAP[u]||u;}
function isMyItem(field,vd){var f=(field||'').toUpperCase();return f===vd||resolveVendor(field)===vd;}
var sem=Math.ceil(((new Date()-new Date(new Date().getFullYear(),0,1))/86400000+new Date(new Date().getFullYear(),0,1).getDay()+1)/7);
var vis=await fbR('visitas');
var tareas=await fbR('tareas');
var inc=await fbR('incidencias');
var est=await fbR('estrategias');
var ops=await fbR('oportunidades');
var mu=await fbR('muestras');
var vd='AZARCO';
var myV=vis.filter(function(v){return parseInt(v.semana||0)===sem&&(isMyItem(v.agente,vd)||isMyItem(v.agenteId,vd));});
var myT=tareas.filter(function(t){return !t.eliminada&&t.estado!=='hecha'&&(isMyItem(t.agente,vd)||isMyItem(t.agenteId,vd));});
var myI=inc.filter(function(x){return !x.eliminada&&x.estado!=='cerrada'&&x.estado!=='resuelta'&&(isMyItem(x.agente,vd)||isMyItem(x.autor,vd));});
var myE=est.filter(function(x){return !x.eliminada&&x.estado==='en_curso'&&isMyItem(x.agente,vd);});
var myO=ops.filter(function(x){return !x.eliminada&&['ganada','perdida','cerrada_ganada','cerrada_perdida'].indexOf(x.estado||x.etapa)===-1&&(isMyItem(x.agente,vd)||isMyItem(x.agenteId,vd));});
var myM=mu.filter(function(x){return !x.eliminada&&x.estado==='pendiente'&&isMyItem(x.agente,vd);});
var total=myV.length+myT.length+myI.length+myE.length+myO.length+myM.length;
return res.status(200).json({semana:sem,vendor:vd,visitas:myV.length,tareas:myT.length,incidencias:myI.length,estrategias:myE.length,oportunidades:myO.length,muestras:myM.length,total:total,skipReason:total===0?'TOTAL=0 -> CONTINUE (no email)':'OK -> email generado',visitasDetalle:myV.map(function(v){return v.clienteNombre||v.cliente;})});
}catch(e){return res.status(200).json({error:e.message});}
};
