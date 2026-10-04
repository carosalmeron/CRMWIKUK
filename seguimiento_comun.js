/* ══ (oct 2026) SEGUIMIENTO DE LA SEMANA ANTERIOR ═══════════════════════
   Lo usan el comité (cierre_semanal.html), el portal de cierres (cierres.html)
   y el cierre del jefe (objetivos_equipo.html). Tres cosas:

   1 · Cumplimiento: lo que el comité/jefe pidió al comercial para esta semana
       (objetivos_semana, origen jefe) y lo que contestó en su parte
       (✅ Hecho / ⏳ En curso / ❌ No lo haré / sin contestar).
   2 · Lo pedido a otros departamentos en los comités (incidencias con
       origen «comite»): contestada, resuelta o sin contestar. Más de 7 días
       sin contestar → sube sola al director.
   3 · «Qué pasó con lo de la semana pasada»: lo que subió o se decidió la
       semana anterior y que ahora hay que marcar (hecho / en curso / no hecho).
         jefe     → lo que subió en sus comités + las acciones que eran suyas
         director → lo que le subieron los jefes + decisiones del CEO
         ceo      → lo que subió el director + sus propias decisiones
       Las marcas se guardan en cierres_flujo/<año>_s<sem>_seg_<papel>_<quien>.
   No escribe nada salvo guardarMarcas().
*/
window.SEG=(function(){
  const FB="https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents";
  const U=(x)=>String(x||"").toUpperCase().trim();
  const val=(f)=>{ if(!f) return null;
    if("stringValue" in f) return f.stringValue;
    if("integerValue" in f) return Number(f.integerValue);
    if("doubleValue" in f) return Number(f.doubleValue);
    if("booleanValue" in f) return f.booleanValue;
    if("timestampValue" in f) return f.timestampValue;
    if("nullValue" in f) return null;
    if("arrayValue" in f) return (f.arrayValue.values||[]).map(val);
    if("mapValue" in f){ const o={}; for(const [k,v] of Object.entries(f.mapValue.fields||{})) o[k]=val(v); return o; }
    return null; };
  const obj=(d)=>{ const o={_id:decodeURIComponent(d.name.split("/").pop())}; for(const [k,x] of Object.entries(d.fields||{})) o[k]=val(x); return o; };
  const J=(s,def)=>{ if(s&&typeof s==="object") return s; try{ return JSON.parse(s||""); }catch(e){ return def; } };
  async function q(col,campo,v){
    const value=typeof v==="number"?{integerValue:String(v)}:typeof v==="boolean"?{booleanValue:v}:{stringValue:String(v)};
    const r=await fetch(FB+":runQuery",{method:"POST",headers:{"Content-Type":"application/json"},cache:"no-store",
      body:JSON.stringify({structuredQuery:{from:[{collectionId:col}],where:{fieldFilter:{field:{fieldPath:campo},op:"EQUAL",value}},limit:3000}})});
    if(!r.ok) return [];
    return ((await r.json())||[]).filter(x=>x.document).map(x=>obj(x.document));
  }
  async function doc(col,id){ try{ const r=await fetch(FB+"/"+col+"/"+encodeURIComponent(id),{cache:"no-store"}); return r.ok?obj(await r.json()):null; }catch(e){ return null; } }
  function isoSem(d){ const t=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())); const dn=t.getUTCDay()||7; t.setUTCDate(t.getUTCDate()+4-dn);
    const a=new Date(Date.UTC(t.getUTCFullYear(),0,1)); return {anio:t.getUTCFullYear(),sem:Math.ceil((((t-a)/86400000)+1)/7)}; }
  function lunes(anio,sem){ const e=new Date(anio,0,4), l=new Date(e); l.setDate(e.getDate()-((e.getDay()||7)-1)); l.setDate(l.getDate()+(sem-1)*7); l.setHours(0,0,0,0); return l; }
  const semAnt=(anio,sem)=>{ const l=lunes(anio,sem); l.setDate(l.getDate()-7); return isoSem(l); };
  const delAnio=(anio)=>(o)=>{ const y=Number(o.anio||o.ano)||0; return !y||y===anio; };

  // ── 1 · Cumplimiento de lo que se le pidió al comercial para la semana <sem>
  const ESTADO=(s)=>{ s=String(s||""); return /Hecho/i.test(s)?"hecho":/curso/i.test(s)?"curso":/No lo har/i.test(s)?"no":"sin"; };
  async function cumplimiento(anio,sem){
    const l=(await q("objetivos_semana","semana",sem)).filter(delAnio(anio))
      .filter(o=>!o.eliminado&&(o.origen==="jefe"||String(o.claveOrigen||"").endsWith("|instr")));
    return l.map(o=>({id:o._id,agente:U(o.agente),equipo:U(o.equipo),texto:o.texto||"",ref:o.refNombre||"",por:o.creadoPorNombre||"",
      estado:ESTADO(o.estadoComercial||o.plan),plan:o.plan||""}));
  }
  // claves: lista de códigos del comercial (o null para todos)
  function resumen(l,claves){
    const s=claves?new Set(claves.map(U)):null, x=s?l.filter(o=>s.has(o.agente)):l;
    const r={tot:x.length,hecho:0,curso:0,no:0,sin:0,items:x};
    x.forEach(o=>r[o.estado]++);
    r.pct=r.tot?Math.round(r.hecho/r.tot*100):null;
    return r;
  }
  const colPct=(p)=>p==null?"#64748B":p>=80?"#15803D":p>=50?"#B45309":"#B91C1C";
  const txtPct=(r)=>r&&r.tot?`${r.hecho} de ${r.tot} cumplidos (${r.pct} %)`:"sin compromisos";

  // ── 2 · Lo pedido a otros departamentos en los comités
  const DIA=86400000;
  async function incsComite(){
    const [a,b]=await Promise.all([q("incidencias","origen","comite"),q("incidencias","deComite",true)]);
    const l=[...new Map([...a,...b].map(i=>[i._id,i])).values()].filter(i=>!i.eliminada);
    const hoy=Date.now();
    return l.map(i=>{
      const h=Array.isArray(i.historialEscalado)?i.historialEscalado:J(i.historialEscalado,[]);
      const resuelta=/cerrad|resuelt/i.test(i.estado||"");
      const contestada=resuelta||(h||[]).length>1;
      const t0=Date.parse(i.fechaCreacion||"")||hoy, dias=Math.floor((hoy-t0)/DIA);
      const ult=(h||[]).length>1?h[h.length-1]:null;
      let que=i.accion||"";
      if(!que){ const d=String(i.descripcion||"").split("\n").map(s=>s.trim()).filter(Boolean);
        que=(d.find(s=>!/^📝|^Punto:|^Para el|^\(Pedido/.test(s))||i.titulo||""); }
      return {id:i._id,dep:i.tipo||"",depNom:i.depNom||i.tipo||"",cliente:i.clienteNombre||"",agente:U(i.agente),equipo:U(i.equipo),
        semana:Number(i.semana)||0,que,fecha:i.fechaCreacion||"",fechaLimite:i.fechaLimite||"",por:i.autorNombre||"",
        estado:resuelta?"resuelta":contestada?"contestada":"sin",dias,sube:!contestada&&dias>7,
        ultima:ult?((ult.por?ult.por+": ":"")+(ult.accion||"")+(ult.nota?" — "+ult.nota:"")):""};
    }).sort((a,b)=>({sin:0,contestada:1,resuelta:2}[a.estado]-({sin:0,contestada:1,resuelta:2}[b.estado]))||b.dias-a.dias);
  }
  // Las que interesan esta semana: abiertas, o resueltas/contestadas en los últimos 7 días
  const vigentes=(l)=>l.filter(i=>i.estado!=="resuelta"||i.dias<=21);
  const ESTADO_INC={sin:["⏳ Sin contestar","#B91C1C"],contestada:["💬 Contestada","#1D4ED8"],resuelta:["✅ Resuelta","#15803D"]};

  // ── 3 · Lo de la semana pasada que hay que marcar
  // equipo: para el jefe. claves: Set de códigos de comerciales de su equipo.
  async function pendientes(papel,anio,sem,op){
    op=op||{}; const a=semAnt(anio,sem), out=[];
    const flu=(await q("cierres_flujo","semana",a.sem)).filter(delAnio(a.anio));
    if(papel==="jefe"){
      const cl=op.claves?new Set([...op.claves].map(U)):null, eq=U(op.equipo);
      flu.filter(c=>c.paso==="comite"&&((cl&&cl.has(U(c.agente)))||(eq&&U(c.equipo)===eq))).forEach(c=>{
        const pu=J(c.puntos,{})||{}, P=pu.p||{}, items=(pu.secciones||[]).flatMap(s=>s.items||[]);
        Object.entries(P).forEach(([k,d])=>{ if(!d||d.r!=="sube") return;
          const it=items.find(x=>x.k===k)||{};
          out.push({id:"sube:"+c.agente+":"+k,tipo:"sube",de:c.agenteNombre||c.agente,agente:U(c.agente),
            texto:(it.nom||k)+(d.t?" — "+d.t:""),origen:"Subió al director en el comité"}); });
        (J(c.acciones,[])||[]).forEach((x,i)=>{ if(!/^(Jefe|Los dos)$/.test(x.quien||"")) return;
          out.push({id:"acc:"+c.agente+":"+i,tipo:"accion",de:c.agenteNombre||c.agente,agente:U(c.agente),
            texto:(x.ref?x.ref+" — ":"")+x.que+(x.cuando?" · para el "+String(x.cuando).split("-").reverse().join("/"):""),
            origen:x.quien==="Los dos"?"Acción tuya y del comercial (comité)":"Acción tuya (comité)"}); });
      });
    }
    if(papel==="director"||papel==="ceo"){
      const inf=(await q("informes","semana",a.sem)).filter(delAnio(a.anio)).filter(i=>i.estado!=="borrador"&&i.tipo==="responsable");
      const rolOk=papel==="director"?/jefe/i:/director/i;
      inf.filter(i=>rolOk.test(i.rol||"")).forEach(i=>{
        const R=J(i.respuestas,{})||{};
        Object.entries(R).forEach(([k,r])=>{ if(!r||!r.texto) return;
          out.push({id:"inf:"+i._id+":"+k,tipo:"sube",de:(i.equipo?i.equipo+" · ":"")+(r.nom||""),
            texto:r.texto,origen:papel==="director"?"Te lo subió el jefe de "+(i.equipo||"equipo"):"Te lo subió el director"}); });
      });
      const ceo=flu.find(c=>c.paso==="ceo");
      (J(ceo&&ceo.decisiones,[])||[]).forEach((d,i)=>{
        if(papel==="director"&&d.para&&!/director|todos/i.test(d.para)) return;
        out.push({id:"ceo:"+i,tipo:"decision",de:d.para||"Todos",texto:d.texto,
          origen:"Decisión del CEO"+(d.para?" para "+d.para:"")+(d.cuando?" · para el "+String(d.cuando).split("-").reverse().join("/"):"")}); });
    }
    return out;
  }
  const idSeg=(anio,sem,papel,quien)=>anio+"_s"+sem+"_seg_"+papel+"_"+String(quien||"").replace(/[\/\s#?]/g,"_");
  async function leerMarcas(anio,sem,papel,quien){ const d=await doc("cierres_flujo",idSeg(anio,sem,papel,quien)); return d?(J(d.marcas,{})||{}):{}; }
  async function guardarMarcas(anio,sem,papel,quien,nombre,marcas,items){
    const id=idSeg(anio,sem,papel,quien);
    const o={anio,semana:sem,paso:"seg",papel,por:String(quien||""),porNombre:nombre||"",fecha:new Date().toISOString(),
      marcas:JSON.stringify(marcas||{}),items:JSON.stringify((items||[]).map(x=>({id:x.id,texto:x.texto,de:x.de,origen:x.origen})))};
    const qs=Object.keys(o).map(k=>"updateMask.fieldPaths="+encodeURIComponent(k)).join("&");
    const f={}; for(const [k,v] of Object.entries(o)) f[k]=typeof v==="number"?{integerValue:String(v)}:{stringValue:String(v)};
    const r=await fetch(`${FB}/cierres_flujo/${encodeURIComponent(id)}?${qs}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({fields:f})});
    if(!r.ok) throw new Error("No se ha guardado (HTTP "+r.status+")");
  }
  // Las marcas de otra persona (p. ej. el CEO ve las del director)
  async function marcasDe(anio,sem,papel){
    const l=(await q("cierres_flujo","semana",sem)).filter(delAnio(anio)).filter(c=>c.paso==="seg"&&c.papel===papel);
    return l.map(c=>({por:c.porNombre||c.por,marcas:J(c.marcas,{})||{},items:J(c.items,[])||[]}));
  }
  const MARCA={hecho:["✅ Hecho","#15803D"],curso:["⏳ En curso","#B45309"],no:["❌ No hecho","#B91C1C"]};

  // ── HTML para correos (estilo de las actas) ──────────────────────────
  const e=(t)=>String(t??"").replace(/[<>&"]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;"}[c]));
  const h3=(t)=>`<div style="font-size:12px;font-weight:800;color:#6B7684;text-transform:uppercase;letter-spacing:.04em;margin:18px 0 6px">${t}</div>`;
  function htmlCumpl(r,titulo,filas){
    if(!r||!r.tot) return "";
    return h3(titulo||"✔️ Compromisos de la semana pasada")
      +`<div style="background:#F7F9FB;border-radius:10px;padding:10px 12px"><div style="font-size:20px;font-weight:800;color:${colPct(r.pct)}">${r.hecho} de ${r.tot} <span style="font-size:13px;font-weight:600;color:#6B7684">cumplidos · ${r.pct} %</span></div>
        <div style="font-size:12px;color:#6B7684">${r.curso?"⏳ "+r.curso+" en curso · ":""}${r.no?"❌ "+r.no+" no se harán · ":""}${r.sin?"⚠️ "+r.sin+" sin contestar":""}</div>
        ${(filas||[]).map(f=>`<div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12.5px"><span style="flex:0 0 42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${e(f.nom)}</span>
          <span style="flex:1;background:#E5E7EB;border-radius:99px;height:7px;overflow:hidden"><span style="display:block;height:7px;width:${f.r.pct||0}%;background:${colPct(f.r.pct)}"></span></span>
          <b style="color:${colPct(f.r.pct)};white-space:nowrap">${f.r.tot?f.r.hecho+"/"+f.r.tot:"—"}</b></div>`).join("")}</div>`;
  }
  function htmlIncs(l,titulo){
    if(!l||!l.length) return "";
    return h3(titulo||"🧩 Lo pedido a otros departamentos")+l.map(i=>{ const s=ESTADO_INC[i.estado];
      return `<div style="border-left:3px solid ${s[1]};background:#F7F9FB;border-radius:0 8px 8px 0;padding:6px 10px;margin:5px 0;font-size:13px">
        <b>${e(i.depNom)}</b>${i.cliente?" · "+e(i.cliente):""} <span style="color:${s[1]};font-size:12px;font-weight:700">${s[0]}${i.estado==="sin"?" · "+i.dias+" días":""}${i.sube?" · 📤 sube al director":""}</span>
        <div style="color:#3A424E">${e(i.que)}</div>${i.ultima?`<div style="font-size:12px;color:#6B7684">↳ ${e(i.ultima)}</div>`:""}</div>`; }).join("");
  }
  function htmlPend(items,marcas,titulo){
    if(!items||!items.length) return "";
    return h3(titulo||"🔁 Qué pasó con lo de la semana pasada")+items.map(x=>{ const m=(marcas||{})[x.id]||{}, s=MARCA[m.e]||["Sin marcar","#94A3B8"];
      return `<div style="border-left:3px solid ${s[1]};background:#F7F9FB;border-radius:0 8px 8px 0;padding:6px 10px;margin:5px 0;font-size:13px">
        <span style="color:${s[1]};font-weight:800;font-size:12px">${s[0]}</span> <b>${e(x.texto)}</b>
        <div style="font-size:12px;color:#6B7684">${e(x.origen)}${x.de?" · "+e(x.de):""}</div>${m.n?`<div style="font-size:12.5px">💬 ${e(m.n)}</div>`:""}</div>`; }).join("");
  }
  return {FB,U,J,q,doc,isoSem,lunes,semAnt,cumplimiento,resumen,colPct,txtPct,incsComite,vigentes,ESTADO_INC,
    pendientes,leerMarcas,guardarMarcas,marcasDe,MARCA,htmlCumpl,htmlIncs,htmlPend};
})();
