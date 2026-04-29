module.exports = async function handler(req, res) {
try {
var nodemailer=require('nodemailer');
var https=require('https');
var FB='https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents';
function httpGet(u){return new Promise(function(r){https.get(u,function(s){var d='';s.on('data',function(c){d+=c;});s.on('end',function(){try{r(JSON.parse(d));}catch(e){r({});}});}).on('error',function(){r({});});});}
function pv(v){if(!v)return '';if(v.stringValue!==undefined)return v.stringValue;if(v.integerValue!==undefined)return parseInt(v.integerValue);if(v.doubleValue!==undefined)return parseFloat(v.doubleValue);if(v.booleanValue!==undefined)return v.booleanValue;if(v.arrayValue)return(v.arrayValue.values||[]).map(pv);if(v.mapValue){var o={};Object.entries(v.mapValue.fields||{}).forEach(function(e){o[e[0]]=pv(e[1]);});return o;}return '';}
async function fbR(c){try{var d=await httpGet(FB+'/'+c+'?pageSize=500');if(!d||!d.documents)return[];return d.documents.map(function(doc){var o={id:doc.name.split('/').pop()};Object.entries(doc.fields||{}).forEach(function(e){o[e[0]]=pv(e[1]);});return o;});}catch(e){return[];}}
var sem=Math.ceil(((new Date()-new Date(new Date().getFullYear(),0,1))/86400000+new Date(new Date().getFullYear(),0,1).getDay()+1)/7);
var portal=await fbR('portal_users');
var vis=[];try{vis=await fbR('visitas');}catch(e){}
var log=[];
var azarcoUsers=portal.filter(function(p){return(p.catalogoVendedor||'').toUpperCase()==='AZARCO';});
log.push('Azarco users: '+azarcoUsers.length);
azarcoUsers.forEach(function(u){log.push('  id:'+u.id+' rol:'+u.rol+' email:'+u.email);});
var ceoUsers=portal.filter(function(p){return p.rol==='ceo'||p.rol==='crm_director'||p.rol==='director';});
log.push('CEO/Dir users: '+ceoUsers.length);
ceoUsers.forEach(function(u){log.push('  id:'+u.id+' rol:'+u.rol+' email:'+u.email);});
var azV=vis.filter(function(v){return parseInt(v.semana||0)===sem&&((v.agente||'').toUpperCase()==='AZARCO'||(v.agenteId||'').toUpperCase()==='AZARCO');});
log.push('Visitas Azarco sem '+sem+': '+azV.length);
if(azV.length===0){
var azV2=vis.filter(function(v){return((v.agente||'').toUpperCase()==='AZARCO'||(v.agenteId||'').toUpperCase()==='AZARCO');});
log.push('Visitas Azarco TODAS semanas: '+azV2.length);
azV2.forEach(function(v){log.push('  sem:'+v.semana+' tipo:'+(typeof v.semana)+' cli:'+(v.clienteNombre||v.cliente||''));});
}else{
azV.forEach(function(v){log.push('  '+v.clienteNombre+' | '+v.resultado+' | '+(v.notas||v.nota||'').substring(0,40));});
}
return res.status(200).json({semana:sem,log:log});
}catch(e){return res.status(200).json({error:e.message});}
};
