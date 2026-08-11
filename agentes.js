/* ============================================================
   agentes.js · Identidad única de comercial
   ------------------------------------------------------------
   Un mismo comercial aparece en los datos con nombres distintos
   según la colección: "AZARCO" en pbi_pedidos, "IK4" en visitas,
   "Antonio Zarco" en ofertas. Cada página se inventaba su propio
   cruce (variantes de código, comparación por nombre, quitar
   ceros...) y ninguna coincidía con las demás.

   Esto lo resuelve en un solo sitio: la colección agentes_alias
   dice a quién pertenece cada identificador. Si mañana aparece
   uno nuevo, se añade una fila y todas las páginas se enteran.

   Uso:
     await Agentes.cargar();
     Agentes.id("AZARCO")          -> "ik4"
     Agentes.nombre("IK4")         -> "ANTONIO ZARCO"
     Agentes.equipo("ik4")         -> "INTERKEY"
     Agentes.mismo("IK4","AZARCO") -> true
     Agentes.alias("ik4")          -> ["IK4","AZARCO",...]
   ============================================================ */
(function(global){
"use strict";

var FB="https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents";

var MAPA={};      // alias normalizado -> {canonico, nombre, equipo}
var POR_CANON={}; // canonico -> {nombre, equipo, alias:[]}
var CARGADO=false;

function norm(s){
  return String(s==null?"":s).toUpperCase().trim()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[^A-Z0-9]/g,"");
}

function val(f){
  if(!f) return null;
  if(f.stringValue!==undefined) return f.stringValue;
  if(f.doubleValue!==undefined) return Number(f.doubleValue);
  if(f.integerValue!==undefined) return Number(f.integerValue);
  if(f.booleanValue!==undefined) return f.booleanValue;
  return null;
}

// Variantes de un código, por si aún no está en la tabla: el desajuste
// habitual es un 0 de más entre el prefijo y el número (U4301468 -> U431468).
function variantes(c){
  c=norm(c);
  if(!c) return [];
  var out=[c], i;
  for(i=0;i<c.length;i++){
    if(c.charAt(i)==="0") out.push(c.slice(0,i)+c.slice(i+1));
  }
  var m=c.match(/^([A-Z]*)(\d+)$/);
  if(m){ out.push(m[1]+"0"+m[2]); out.push(m[2]); out.push("U"+m[2]); }
  return out.filter(function(v,ix,a){ return v&&a.indexOf(v)===ix; });
}

async function cargar(forzar){
  if(CARGADO&&!forzar) return MAPA;
  MAPA={}; POR_CANON={};
  var tok=null, vueltas=0;
  try{
    do{
      var url=FB+"/agentes_alias?pageSize=300"+(tok?"&pageToken="+encodeURIComponent(tok):"");
      var r=await fetch(url);
      if(!r.ok) break;
      var j=await r.json();
      (j.documents||[]).forEach(function(d){
        var o={}, f=d.fields||{};
        for(var k in f) o[k]=val(f[k]);
        var alias=norm(o.alias||decodeURIComponent(d.name.split("/").pop()));
        if(!alias||!o.canonico) return;
        MAPA[alias]={canonico:o.canonico, nombre:o.nombre||o.canonico,
          equipo:o.equipo||"", original:o.original||alias};
        var c=POR_CANON[o.canonico]||(POR_CANON[o.canonico]=
          {nombre:o.nombre||o.canonico, equipo:o.equipo||"", alias:[]});
        if(c.alias.indexOf(alias)<0) c.alias.push(alias);
        if(o.nombre&&o.nombre.length>c.nombre.length) c.nombre=o.nombre;
        if(o.equipo&&!c.equipo) c.equipo=o.equipo;
      });
      tok=j.nextPageToken||null; vueltas++;
    }while(tok&&vueltas<20);
    CARGADO=true;
  }catch(e){
    // Sin tabla se sigue funcionando: se resuelve por variantes, como antes
    console.warn("[Agentes] no se ha podido leer agentes_alias:",e);
  }
  return MAPA;
}

// Ficha de quien sea ese identificador, o null
function ficha(x){
  var k=norm(x);
  if(!k) return null;
  if(MAPA[k]) return MAPA[k];
  // Aún no está en la tabla: se prueban las variantes conocidas
  var vs=variantes(k), i;
  for(i=0;i<vs.length;i++) if(MAPA[vs[i]]) return MAPA[vs[i]];
  return null;
}

function id(x){       var f=ficha(x); return f?f.canonico:(x?String(x):""); }
function nombre(x){   var f=ficha(x); return f?f.nombre:(x?String(x):""); }
function equipo(x){   var f=ficha(x); return f?f.equipo:""; }
function conocido(x){ return !!ficha(x); }

// ¿Son la misma persona? Es la pregunta que se hace en casi todos los cruces
function mismo(a,b){
  if(!a||!b) return false;
  var fa=ficha(a), fb=ficha(b);
  if(fa&&fb) return fa.canonico===fb.canonico;
  // Si alguno no está en la tabla, se comparan las variantes
  var va=variantes(a), vb=variantes(b);
  return va.some(function(x){ return vb.indexOf(x)>=0; });
}

// Todos los identificadores de una persona, para filtrar colecciones
function alias(x){
  var f=ficha(x);
  var c=f?POR_CANON[f.canonico]:null;
  if(c) return c.alias.slice();
  return variantes(x);
}

// ¿Este documento es de esta persona? Mira los campos habituales
var CAMPOS=["agente","agenteId","agenteNombre","responsableComercial",
            "creadoPor","vendedor","comercial","uid"];
function esDe(doc,persona){
  if(!doc||!persona) return false;
  for(var i=0;i<CAMPOS.length;i++){
    var v=doc[CAMPOS[i]];
    if(v&&mismo(v,persona)) return true;
  }
  return false;
}

// Personas distintas que hay en una lista de documentos
function personasDe(docs){
  var vistos={}, out=[];
  (docs||[]).forEach(function(d){
    for(var i=0;i<CAMPOS.length;i++){
      var v=d[CAMPOS[i]];
      if(!v) continue;
      var c=id(v);
      if(c&&!vistos[c]){
        vistos[c]=1;
        out.push({canonico:c, nombre:nombre(v), equipo:equipo(v)});
      }
      break;
    }
  });
  return out;
}

global.Agentes={
  cargar:cargar, id:id, nombre:nombre, equipo:equipo,
  mismo:mismo, alias:alias, esDe:esDe, ficha:ficha,
  conocido:conocido, personasDe:personasDe,
  norm:norm, variantes:variantes,
  get cargado(){ return CARGADO; },
  get total(){ return Object.keys(MAPA).length; }
};

})(window);
