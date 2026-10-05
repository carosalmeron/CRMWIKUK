/* ══ (oct 2026) MAPA DE NEGOCIO · clasificación común ═══════════════════
   Qué es negocio estratégico y qué no. Dos maestros, manuales:
     clasif_articulos/<código>  tipo: estrategica | gancho | fuera
        Vale para TODOS los clientes. Excepción por cliente: en la ficha de
        recuperación se puede devolver un artículo a venta estratégica solo
        para ese cliente (queda en el caso, campo artExcepJSON).
     clasif_clientes/<código>   tipo: estrategico | no_estrategico
        Lo decide el jefe. Un cliente no estratégico queda en recuperación
        como «🚫 cliente fuera de estrategia» (y al revés).
   Lo usan mapa_negocio.html y recuperacion.html. Necesita recuperacion_comun.js (RC).
*/
window.MAPA=(function(){
  const ARR=(s)=>String(s||"").toUpperCase().trim();
  const num=(n)=>Number(n)||0;
  const idDoc=(c)=>ARR(c).replace(/[\/#?\[\]*]/g,"_")||"SIN_CODIGO";
  const base=(c)=>ARR(c).replace(/\.[A-Z0-9]+$/,"");
  const POR_MAPA="🧭 Mapa de negocio";
  let CA=null, CC=null, REC=new Map();
  // (oct 2026) Lo marcado a mano en recuperación cliente a cliente. Un artículo marcado 🪝 gancho en
  // cualquier cliente es gancho para toda la empresa (el gancho es del artículo), salvo que en el mapa
  // se haya decidido otra cosa. Lo marcado 🚫 fuera queda solo como pista: suele ser de ese cliente.
  function setRec(casos){
    const m=new Map();
    (casos||[]).forEach(c=>RC.spotDe(c).forEach(x=>{ if(x.global) return; const k=ARR(x.art); if(!k) return;
      const s=m.get(k)||{gancho:0,fuera:0,cli:new Set(),desc:x.desc||""}; if(s.cli.has(c.cliente)) return;
      s.cli.add(c.cliente); s[RC.tipoClasif(x)]++; m.set(k,s); }));
    REC=m; return m;
  }
  const recDe=(cod)=>REC.get(ARR(cod))||REC.get(base(cod))||null;

  async function arts(forzar){
    if(CA&&!forzar) return CA;
    const m=new Map();
    try{ (await RC.leer("clasif_articulos")).forEach(d=>{ if(d.tipo) m.set(ARR(d.codigo||d._id),d); }); }catch(e){}
    CA=m; return CA;
  }
  async function clis(forzar){
    if(CC&&!forzar) return CC;
    const m=new Map();
    try{ (await RC.leer("clasif_clientes")).forEach(d=>{ if(d.tipo) m.set(ARR(d.codigo||d._id),d); }); }catch(e){}
    CC=m; return CC;
  }
  // Tipo global de un artículo (por su código o por el código sin envase)
  const tipoArt=(cod)=>{ if(!cod) return null; const d=CA&&(CA.get(ARR(cod))||CA.get(base(cod))); if(d&&d.tipo) return d.tipo;
    const r=recDe(cod); return r&&r.gancho?"gancho":null; };
  // De dónde sale la clase: "mapa" (decidido aquí), "recuperacion" (gancho marcado en algún cliente) o null
  const origenArt=(cod)=>{ const d=CA&&(CA.get(ARR(cod))||CA.get(base(cod))); if(d&&d.tipo) return "mapa"; const r=recDe(cod); return r&&r.gancho?"recuperacion":null; };
  const tipoCli=(cod)=>{ if(!CC||!cod) return null; const d=CC.get(ARR(cod)); return d&&d.tipo||null; };

  async function guardarArt(cod,tipo,info,por){
    info=info||{};
    const d={codigo:ARR(cod),tipo:tipo||"",descripcion:info.descripcion||info.desc||"",calibre:info.calibre||info.cal||"",
      por:por||"",fecha:new Date().toISOString()};
    await RC.guardarEn("clasif_articulos",idDoc(cod),d);
    if(CA){ if(tipo) CA.set(ARR(cod),d); else CA.delete(ARR(cod)); }
    return d;
  }
  async function guardarCli(cod,tipo,info,por){
    info=info||{};
    const d={codigo:ARR(cod),tipo:tipo||"",motivo:info.motivo||"",nota:info.nota||"",nombre:info.nombre||"",
      agente:info.agente||"",equipo:info.equipo||"",por:por||"",fecha:new Date().toISOString()};
    await RC.guardarEn("clasif_clientes",idDoc(cod),d);
    if(CC){ if(tipo) CC.set(ARR(cod),d); else CC.delete(ARR(cod)); }
    return d;
  }

  // Excepciones del cliente: artículos que el jefe ha devuelto a venta estratégica solo para él
  const excepciones=(c)=>{ try{ const l=typeof c.artExcepJSON==="string"?JSON.parse(c.artExcepJSON||"[]"):(c.artExcepJSON||[]); return Array.isArray(l)?l.map(ARR):[]; }catch(e){ return []; } };
  const conExcepcion=(c,cods)=>{ const s=new Set(excepciones(c)); cods.forEach(k=>{ if(k) s.add(ARR(k)); }); return JSON.stringify([...s]); };
  const sinExcepcion=(c,cods)=>{ const q=new Set(cods.map(ARR)); return JSON.stringify(excepciones(c).filter(k=>!q.has(k))); };

  // Aplica la clasificación global de artículos a un caso de recuperación.
  // A = {caen:[{art,desc,cal,dif,ant,act}], suben:[…]} (lo que devuelve articulosCliente).
  // Devuelve null si no cambia nada, o los campos a guardar.
  function calcular(c,A){
    if(!c||!RC.abierto(c)||!CA||!A) return null;
    const exc=new Set(excepciones(c)), ahora=new Date().toISOString();
    let L=RC.spotDe(c).slice(), perd=num(c.perdido), cambios=[];
    const key=(x)=>ARR(x.art||x.desc);
    // 1) Lo que se puso desde el mapa y ya no vale (el artículo ha cambiado de tipo o se ha quitado)
    L=L.filter(x=>{
      if(!x.global) return true;
      const t=tipoArt(x.art);
      if(t==="gancho"||t==="fuera"){ if(t!==x.tipo){ x.tipo=t; x.fecha=ahora; cambios.push(`${RC.CLASIF[t][0]} ${x.desc||x.art}`); } return true; }
      if(!x.crece) perd+=Math.max(0,-(num(x.dif)));
      cambios.push(`↩️ ${x.desc||x.art}`); return false; });
    const ya=new Set(L.map(key));
    // 2) Lo nuevo
    const add=(a,crece)=>{ const k=ARR(a.art); if(!k||ya.has(k)||exc.has(k)) return;
      const t=tipoArt(k); if(t!=="gancho"&&t!=="fuera") return;
      L.push(Object.assign({art:a.art,desc:a.desc,cal:a.cal||"",dif:a.dif,ant:a.ant,act:a.act,tipo:t,por:POR_MAPA,fecha:ahora,global:true},crece?{crece:true}:{}));
      ya.add(k); if(!crece) perd=Math.max(0,perd-Math.max(0,-num(a.dif)));
      cambios.push(`${RC.CLASIF[t][0]} ${a.desc||a.art}`); };
    (A.caen||[]).filter(a=>num(a.dif)<0).forEach(a=>add(a,false));
    (A.suben||[]).filter(a=>num(a.dif)>0).forEach(a=>add(a,true));
    if(!cambios.length) return null;
    return {spotJSON:JSON.stringify(L),perdido:Math.round(perd),cambios};
  }
  async function aplicar(c,A,sem){
    const r=calcular(c,A); if(!r) return null;
    const ahora=new Date().toISOString();
    const hist=(c.historial||[]).concat([{sem:sem||RC.semanaISO(new Date()),fecha:ahora,por:POR_MAPA,
      sistema:`${POR_MAPA} (clasificación de artículos): ${r.cambios.slice(0,8).join(", ")}${r.cambios.length>8?" y "+(r.cambios.length-8)+" más":""}`}]);
    const campos={spotJSON:r.spotJSON,perdido:r.perdido,historial:hist};
    await RC.guardar(c._id,campos); Object.assign(c,campos);
    return r;
  }
  // Para el mapa: los artículos de un cliente en el formato de la ficha
  async function articulosDe(cli){
    const r=await fetch(`/api/pbi-sync?articulosCliente=${encodeURIComponent(cli)}&top=30`);
    const j=await r.json(); if(j.ok===false) throw new Error(j.error||"sin respuesta");
    const m=(a)=>({art:a.articulo,desc:a.descripcion||a.articulo,cal:a.calibre||"",act:Math.round(num(a.ventasAct)),ant:Math.round(num(a.ventasAnt)),dif:Math.round(num(a.diferencia))});
    return {caen:(j.articulos||[]).map(m),suben:(j.suben||[]).map(m)};
  }
  return {setRec,recDe,origenArt,arts,clis,tipoArt,tipoCli,guardarArt,guardarCli,excepciones,conExcepcion,sinExcepcion,calcular,aplicar,articulosDe,idDoc,POR_MAPA,VERSION:"20261005b"};
})();
