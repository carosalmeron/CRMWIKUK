// ═══════════════════════════════════════════════════════════════════════
// PLAN DE RECUPERACIÓN DE CLIENTES · lógica común (sep 2026)
// La usan cierre_semanal.html (el comercial), recuperacion.html (jefe, CEO,
// comité del viernes) y objetivos_equipo.html (cierre del jefe).
//
// Reglas aprobadas por el CEO el 29/09/2026:
//   · Se abre caso si el cliente pierde >15 % en el año y >3.000 €, o lleva
//     2 meses sin comprar comprando antes cada mes, o cae >40 % en 2 meses
//     (siempre con al menos 3.000 € en juego).
//   · Nivel 1 comercial · 20.000 € jefe de ventas · 50.000 € CEO.
//   · 14 días sin acción → sube un nivel.
//   · Oferta de vuelta: margen ≥ 10 % sin permiso; por debajo, la aprueba el CEO.
//   · Todos los equipos menos Francia.
//   · Solo el CEO archiva un caso sin recuperar, con motivo.
//   · Recuperado: 2 meses completos seguidos al 70 % de su ritmo.
// ═══════════════════════════════════════════════════════════════════════
(function(g){
  const RC={};
  RC.FB="https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents";
  RC.COL="recuperacion";
  RC.UMBRAL={ pct:0.15, euros:3000, bruscaPct:-40, ritmoMin:400,
              nivel2:20000, nivel3:50000, diasSinAccion:14,
              margenMin:10, recupera:0.70, nuevosPorSemana:8 };
  RC.CAUSAS=["Precio","Calidad","Plazo de entrega","Calibre o formato",
    "Competencia","Cambio de comprador","El cliente vende menos",
    "Impago o riesgo","Cierre del negocio","Otra"];
  RC.ACCIONES=["Visita presencial","Llamada","Oferta de vuelta",
    "Muestra nueva","Compromiso de plazo","Visita con el jefe de ventas",
    "Llamada o visita del CEO","Otra"];
  RC.HECHO=["Visitado","Llamado","Oferta enviada","Muestra enviada",
    "Reunión con jefe/CEO","No he podido"];
  RC.MOTIVOS_ARCHIVO=["Impago","Cierre del negocio","No es rentable",
    "Decisión estratégica","El dato está mal","Otro"];
  RC.DATO_MAL="El dato está mal";
  // Quién puede archivar (dejar de insistir). Aprobado por el CEO el 29/09/2026:
  //   · CEO: cualquier caso.
  //   · Jefe / jefe de ventas: los de menos de 20.000 €, y cualquiera cuyo
  //     motivo sea que el dato está mal (códigos duplicados, mal asignado).
  RC.puedeArchivar=(esCeo,esJefe,caso,motivo)=>{
    if(esCeo) return true;
    if(!esJefe) return false;
    if(motivo===RC.DATO_MAL) return true;
    return num(caso&&caso.perdido)<RC.UMBRAL.nivel2;
  };
  RC.motivosPara=(esCeo,esJefe,caso)=>RC.MOTIVOS_ARCHIVO.filter(m=>RC.puedeArchivar(esCeo,esJefe,caso,m));
  RC.ABIERTOS=["abierto","diagnosticado","en_accion","propuesta_archivo"];
  RC.NIVEL_TXT={1:"Comercial",2:"Con jefe de ventas",3:"CEO"};
  RC.NIVEL_COL={1:"#16A34A",2:"#D97706",3:"#DC2626"};

  const ARR=(s)=>String(s||"").toUpperCase().trim();
  const num=(n)=>Number(n)||0;
  RC.ARR=ARR; RC.num=num;
  RC.eur=(n)=>(n<0?"-":"")+String(Math.round(Math.abs(n||0))).replace(/\B(?=(\d{3})+(?!\d))/g,".")+" €";
  RC.esFrancia=(eq)=>/FRANC/i.test(String(eq||""));
  RC.idDe=(cli)=>"rec_"+String(cli||"").replace(/[\/\s#?]/g,"_");
  RC.dias=(iso)=>{ const t=Date.parse(iso||""); return isNaN(t)?null:Math.floor((Date.now()-t)/86400000); };

  // Semana ISO
  RC.semanaISO=(d)=>{ d=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));
    const n=d.getUTCDay()||7; d.setUTCDate(d.getUTCDate()+4-n);
    const y=new Date(Date.UTC(d.getUTCFullYear(),0,1));
    return Math.ceil(((d-y)/86400000+1)/7); };

  // ── Firestore ─────────────────────────────────────────────────────────
  function val(f){
    if(!f) return null;
    if(f.stringValue!==undefined) return f.stringValue;
    if(f.integerValue!==undefined) return Number(f.integerValue);
    if(f.doubleValue!==undefined) return Number(f.doubleValue);
    if(f.booleanValue!==undefined) return f.booleanValue;
    return null;
  }
  RC.val=val;
  RC.desdeFB=(d)=>{ const o={_id:decodeURIComponent(d.name.split("/").pop())};
    for(const [k,x] of Object.entries(d.fields||{})) o[k]=val(x); return o; };
  RC.aFB=(o)=>{ const f={};
    for(const [k,v] of Object.entries(o)){
      if(k==="_id"||v===undefined) continue;
      if(v===null) f[k]={nullValue:null};
      else if(typeof v==="number") f[k]={doubleValue:v};
      else if(typeof v==="boolean") f[k]={booleanValue:v};
      else if(typeof v==="object") f[k]={stringValue:JSON.stringify(v)};
      else f[k]={stringValue:String(v)};
    } return f; };
  RC.leer=async(col,max)=>{
    const t=[]; let tok=null,v=0;
    do{
      const r=await fetch(`${RC.FB}/${col}?pageSize=300`+(tok?`&pageToken=${encodeURIComponent(tok)}`:""),{cache:"no-store"});
      if(!r.ok) break;
      const j=await r.json();
      for(const d of j.documents||[]) t.push(RC.desdeFB(d));
      tok=j.nextPageToken||null; v++;
    }while(tok&&v<(max||60));
    return t;
  };
  RC.leerCasos=()=>RC.leer(RC.COL).then(l=>l.map(RC.normaliza));
  // Guarda solo los campos indicados (no pisa lo demás)
  RC.guardar=async(id,campos)=>{
    const qs=Object.keys(campos).filter(k=>k!=="_id")
      .map(k=>"updateMask.fieldPaths="+encodeURIComponent(k)).join("&");
    const r=await fetch(`${RC.FB}/${RC.COL}/${encodeURIComponent(id)}?${qs}`,{
      method:"PATCH",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({fields:RC.aFB(campos)})});
    if(!r.ok) throw new Error("HTTP "+r.status);
    return true;
  };
  RC.normaliza=(c)=>{
    try{ c.historial=typeof c.historial==="string"?JSON.parse(c.historial||"[]"):(c.historial||[]); }
    catch(e){ c.historial=[]; }
    c.perdido=num(c.perdido); c.nivel=num(c.nivel)||1;
    c.productos=RC.prodDe(c);
    return c;
  };
  RC.abierto=(c)=>RC.ABIERTOS.includes(c.estado||"abierto");
  RC.tienePlan=(c)=>!!(c.causa&&c.accion&&c.fechaObjetivo&&num(c.eurosObjetivo)>0);

  // ── Detección ─────────────────────────────────────────────────────────
  // cli: documento de pbi_ventas_cliente · fila: [codigo, ene..dic] de este año
  // ultimo: meses completos del año (getMonth())
  RC.evaluar=(cli,fila,ultimo)=>{
    if(!cli) return null;
    const ok=cli.cuenta!==undefined?cli.cuenta:(!cli.intercompany&&!cli.fusionadoEn);
    if(!ok||cli.obsoleto) return null;
    // Su venta se ha ido entera a otro código del mismo cliente
    const traspasoTotal=cli.traspaso&&!(num(cli.caida)<0);
    if(traspasoTotal) return null;
    const act=num(cli.ventasAct), ant=num(cli.ventasAntYTD);
    const cands=[];
    // A · cae en el año
    const perdAnual=cli.traspaso?-num(cli.caida):ant-act;
    if(ant>0&&perdAnual>RC.UMBRAL.euros&&perdAnual>=ant*RC.UMBRAL.pct){
      cands.push({tipo:"anual",perdido:perdAnual,
        motivo:`cae un ${Math.round(perdAnual/ant*100)} % en el año · ${RC.eur(act)} frente a ${RC.eur(ant)}`,
        ritmoRef:ultimo?ant/Math.max(ultimo,1):ant/12});
    }
    // B y C · cambio de comportamiento reciente (meses facturados)
    if(fila){
      const hasta=Math.max(ultimo-1,0);          // el mes recién cerrado aún no está facturado
      const m=[]; for(let i=1;i<=hasta;i++) m.push(num(fila[i]));
      if(m.length>=4){
        const rec=m.slice(-2), pre=m.slice(0,-2).filter(x=>x>0);
        if(pre.length>=2){
          const ritmo=pre.reduce((a,b)=>a+b,0)/pre.length;
          const ahora=(rec[0]+rec[1])/2;
          let seco=0; for(let i=m.length-1;i>=0&&m[i]===0;i--) seco++;
          const caida=ritmo?(ahora-ritmo)/ritmo*100:0;
          const perd=(ritmo-ahora)*2;
          if(ritmo>=RC.UMBRAL.ritmoMin&&perd>RC.UMBRAL.euros){
            if(seco>=2) cands.push({tipo:"seco",perdido:perd,ritmoRef:ritmo,
              motivo:`lleva ${seco} meses sin comprar · venía de ${RC.eur(ritmo)} al mes`});
            else if(caida<=RC.UMBRAL.bruscaPct) cands.push({tipo:"brusca",perdido:perd,ritmoRef:ritmo,
              motivo:`compraba ${RC.eur(ritmo)} al mes y ahora ${RC.eur(ahora)} (${Math.round(caida)} %)`});
          }
        }
      }
    }
    if(!cands.length) return null;
    cands.sort((a,b)=>b.perdido-a.perdido);
    const c=cands[0];
    c.perdido=Math.round(c.perdido); c.ritmoRef=Math.round(c.ritmoRef||0);
    c.ventasAct=Math.round(act); c.ventasAnt=Math.round(ant);
    if(cli.traspaso) c.traspaso=cli.traspaso;
    return c;
  };

  RC.nivelBase=(perdido)=>perdido>=RC.UMBRAL.nivel3?3:perdido>=RC.UMBRAL.nivel2?2:1;
  // Nivel con escalado por inactividad
  RC.nivelDe=(caso)=>{
    const base=RC.nivelBase(num(caso.perdido));
    const ref=caso.ultimaAccion||caso.abierto;
    const d=RC.dias(ref);
    const parado=d!=null&&d>RC.UMBRAL.diasSinAccion&&caso.estado!=="propuesta_archivo";
    const n=Math.min(3,base+(parado?1:0));
    return {nivel:n, motivo:parado&&n>base?`${d} días sin acción`:(n>=2?"por importe":"")};
  };

  // Recuperado: los 2 últimos meses completos, posteriores a la apertura,
  // al 70 % de su ritmo de referencia.
  RC.recuperado=(caso,fila,ultimo)=>{
    if(!fila||!caso.abierto) return false;
    const mAp=new Date(caso.abierto).getMonth()+1;    // mes de apertura (1-12)
    const a=ultimo-1, b=ultimo;                        // dos últimos meses completos
    if(a<=mAp) return false;
    const ref=num(caso.ritmoRef); if(!ref) return false;
    return num(fila[a])>=ref*RC.UMBRAL.recupera&&num(fila[b])>=ref*RC.UMBRAL.recupera;
  };

  // Sincroniza los casos de una cartera: abre los nuevos, actualiza cifras,
  // nivel y detecta recuperados. Devuelve los casos resultantes.
  // clientes: sus documentos de pbi_ventas_cliente · mes: mapa código→fila
  // existentes: casos ya guardados de esos clientes (por _id)
  RC.sincronizar=async(agente,equipo,clientes,mes,existentes,opts)=>{
    opts=opts||{};
    const ultimo=new Date().getMonth();
    const ahora=new Date().toISOString();
    const semana=RC.semanaISO(new Date());
    const porId={}; (existentes||[]).forEach(c=>porId[c._id]=c);
    const out=[]; const escribir=[];
    for(const cli of clientes){
      const id=RC.idDe(cli._id);
      const prev=porId[id];
      const fila=mes[ARR(cli._id)];
      const ev=RC.evaluar(cli,fila,ultimo);
      if(prev){
        const c=Object.assign({},prev);
        if(!RC.abierto(c)){
          // Cerrado. Si era recuperado y vuelve a caer pasados 60 días, se reabre.
          const d=RC.dias(c.recuperadoEn);
          if(c.estado==="recuperado"&&ev&&d!=null&&d>60){
            const hist=(c.historial||[]).concat([{sem:semana,fecha:ahora,sistema:`Reabierto: ${ev.motivo}`}]);
            Object.assign(c,{estado:"abierto",abierto:ahora,semanaApertura:semana,tipo:ev.tipo,
              motivo:ev.motivo,perdido:ev.perdido,ritmoRef:ev.ritmoRef,causa:"",accion:"",
              fechaObjetivo:"",eurosObjetivo:0,historial:hist,ultimaAccion:"",agente,equipo});
            escribir.push(c);
          }
          out.push(c); continue;
        }
        // Abierto: ¿se ha recuperado?
        if(RC.recuperado(c,fila,ultimo)){
          c.estado="recuperado"; c.recuperadoEn=ahora;
          c.historial=(c.historial||[]).concat([{sem:semana,fecha:ahora,sistema:"Recuperado: 2 meses al 70 % de su ritmo"}]);
          escribir.push(c); out.push(c); continue;
        }
        // Cifras al día (el caso sigue aunque la regla deje de saltar)
        if(ev){ c.perdido=ev.perdido; c.motivo=ev.motivo; c.tipo=ev.tipo; }
        c.ventasAct=Math.round(num(cli.ventasAct)); c.ventasAnt=Math.round(num(cli.ventasAntYTD));
        c.agente=agente; c.equipo=equipo; c.nombre=cli.nombre||c.nombre||cli._id;
        const nv=RC.nivelDe(c); c.nivel=nv.nivel; c.nivelMotivo=nv.motivo;
        const cambia=["perdido","motivo","ventasAct","ventasAnt","nivel","agente","equipo","nivelMotivo"]
          .some(k=>String(c[k])!==String(prev[k]));
        if(cambia) escribir.push(c);
        out.push(c); continue;
      }
      if(!ev) continue;
      const c={_id:id,cliente:String(cli._id),nombre:cli.nombre||String(cli._id),
        poblacion:cli.poblacion||"",agente,equipo,abierto:ahora,semanaApertura:semana,
        tipo:ev.tipo,motivo:ev.motivo,perdido:ev.perdido,ritmoRef:ev.ritmoRef,
        ventasAct:ev.ventasAct,ventasAnt:ev.ventasAnt,traspaso:ev.traspaso||"",
        estado:"abierto",causa:"",causaNota:"",accion:"",accionNota:"",margenOferta:null,
        necesitaAprobacion:"",fechaObjetivo:"",eurosObjetivo:0,historial:[],
        ultimaAccion:"",nivel:RC.nivelBase(ev.perdido),nivelMotivo:"",creadoPor:opts.por||agente};
      escribir.push(c); out.push(c);
    }
    if(!opts.soloLeer){
      for(const c of escribir){
        const o=Object.assign({},c); o.actualizado=ahora;
        try{ await RC.guardar(c._id,o); }catch(e){ c._errorGuardar=e.message; }
      }
    }
    out.escritos=escribir.length;
    return out;
  };

  // ── Productos que ha dejado de comprar ────────────────────────────────
  // Usa la misma consulta que el CRM al abrir un cliente (artículos que más
  // caen frente al mismo periodo del año pasado). Se guarda en el caso para
  // que el comité y los informes lo vean sin volver a Power BI.
  RC.PROD_DIAS=7;
  RC.prodTexto=(a)=>[a.descripcion||a.articulo, a.calibre?"cal. "+a.calibre:"", a.metros?a.metros+" m":""]
    .filter(Boolean).join(" · ");
  RC.cargarProductos=async(caso,forzar)=>{
    if(!caso||!caso.cliente) return null;
    // v2: 8 artículos en vez de 5; lo guardado con la versión anterior se renueva
    if(!forzar&&caso.productos&&!caso.productos.error&&caso.productos.v===2){
      const d=RC.dias(caso.productosEn);
      if(d!=null&&d<RC.PROD_DIAS) return caso.productos;
    }
    // Power BI puede tardar si el cliente no está consultado de antes
    const ctl=typeof AbortController!=="undefined"?new AbortController():null;
    const tope=setTimeout(()=>{ try{ ctl&&ctl.abort(); }catch(e){} },55000);
    try{
      const r=await fetch(`/api/pbi-sync?articulosCliente=${encodeURIComponent(caso.cliente)}&top=10`,ctl?{signal:ctl.signal}:{});
      if(!r.ok) throw new Error("Power BI respondió "+r.status);
      const j=await r.json();
      if(j&&j.ok===false) throw new Error(j.error||"sin respuesta");
      const m=(a)=>({art:a.articulo,desc:RC.prodTexto(a),act:Math.round(num(a.ventasAct)),ant:Math.round(num(a.ventasAnt))});
      const p={caen:(j.articulos||[]).filter(a=>num(a.diferencia)<0).slice(0,8).map(m),
               suben:(j.suben||[]).filter(a=>num(a.diferencia)>0).slice(0,3).map(m),v:2};
      caso.productos=p; caso.productosEn=new Date().toISOString();
      try{ await RC.guardar(caso._id,{productos:p,productosEn:caso.productosEn}); }catch(e){}
      return p;
    }catch(e){
      return {error:(e&&e.name==="AbortError")?"Power BI tarda demasiado":String(e&&e.message||e)};
    }finally{ clearTimeout(tope); }
  };
  RC.prodDe=(c)=>{ let p=c&&c.productos; if(typeof p==="string"){ try{ p=JSON.parse(p); }catch(e){ p=null; } } return p; };
  // Lista corta en HTML (para pantallas y correos: estilos en línea)
  RC.htmlProductos=(p,opts)=>{
    opts=opts||{};
    if(!p) return opts.cargando?`<div style="font-size:12px;color:#8A94A0">Buscando qué ha dejado de comprar… (la primera vez tarda unos segundos)</div>`:"";
    if(p.error) return `<div style="font-size:12px;color:#B45309">No se ha podido consultar qué ha dejado de comprar (${String(p.error).replace(/[<>&]/g,"")}).${opts.reintentar?` <a href="#" onclick="${opts.reintentar};return false" style="color:#2563EB;font-weight:700">Reintentar</a>`:""}</div>`;
    const esc=(t)=>String(t??"").replace(/[<>&]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]));
    const max=opts.max||5;
    if(!p.caen||!p.caen.length) return `<div style="font-size:12px;color:#8A94A0">No hay un producto concreto que caiga: baja un poco en todo.</div>`;
    const caen=p.caen.slice(0,max), suben=opts.sinSuben?[]:(p.suben||[]);
    // Un importe negativo este año es un abono o una devolución, no una venta
    const imp=(v,col)=>v<0?`<b style="color:#C2263D">${RC.eur(v)}</b> <span style="color:#8A94A0">(abono)</span>`:`<b style="color:${col}">${RC.eur(v)}</b>`;
    const fila=(a,col)=>`<tr><td style="padding:3px 8px 3px 0;font-size:12px;line-height:1.35">${esc(a.desc)}${a.art&&a.desc!==a.art?`<span style="color:#8A94A0"> · ${esc(a.art)}</span>`:""}</td>
      <td style="padding:3px 0;font-size:12px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums">${RC.eur(a.ant)} → ${imp(a.act,a.act?"#B45309":"#C2263D")}</td></tr>`;
    // Cuadre con la cabecera: la lista es solo lo más grande
    const pierde=caen.reduce((t,a)=>t+(num(a.ant)-num(a.act)),0);
    const gana=suben.reduce((t,a)=>t+(num(a.act)-num(a.ant)),0);
    const tot=num(opts.perdido);
    let cuadre="";
    if(tot>0){
      const resto=Math.round(tot-pierde+gana);
      cuadre=`<div style="font-size:11.5px;color:#6B7684;margin-top:5px;line-height:1.4">
        ${caen.length===1?"Este artículo explica":"Estos "+caen.length+" artículos explican"} <b>${RC.eur(pierde)}</b> de los <b>${RC.eur(tot)}</b> que cae el cliente${gana?`, y lo que compra más compensa ${RC.eur(gana)}`:""}.
        ${Math.abs(resto)>Math.max(50,tot*0.02)?(resto>0?`Los otros <b>${RC.eur(resto)}</b> vienen de artículos más pequeños o de abonos.`
          :`El resto de artículos compensa ${RC.eur(-resto)}.`):""}</div>`;
    }
    return `<div style="margin:6px 0 2px">
      <div style="font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#8A94A0">Lo que más cae · año pasado → este año</div>
      <table style="width:100%;border-collapse:collapse">${caen.map(a=>fila(a,"#B45309")).join("")}</table>
      ${suben.length?`<div style="font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#8A94A0;margin-top:5px">En cambio compra más</div>
      <table style="width:100%;border-collapse:collapse">${suben.map(a=>`<tr><td style="padding:3px 8px 3px 0;font-size:12px;line-height:1.35">${esc(a.desc)}${a.art&&a.desc!==a.art?`<span style="color:#8A94A0"> · ${esc(a.art)}</span>`:""}</td>
        <td style="padding:3px 0;font-size:12px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums">${RC.eur(a.ant)} → <b style="color:#0E7C5A">${RC.eur(a.act)}</b></td></tr>`).join("")}</table>`:""}
      ${cuadre}
    </div>`;
  };
  // Carga en paralelo (de 3 en 3) y avisa al terminar cada uno
  RC.cargarVarios=async(casos,alTerminar)=>{
    const cola=casos.slice(); const trab=async()=>{ while(cola.length){ const c=cola.shift();
      const p=await RC.cargarProductos(c); try{ alTerminar&&alTerminar(c,p); }catch(e){} } };
    await Promise.all([trab(),trab(),trab()]);
  };

  // ── Instrucciones: aviso por correo ──────────────────────────────────
  // Le llega al comercial y, en copia, a su jefe de equipo, al jefe de ventas
  // y al CEO (menos a quien la manda). Así nadie se entera el viernes.
  RC.destinatarios=async(agente,quienId)=>{
    const U=(x)=>String(x||"").toUpperCase().trim();
    const [us,pu]=await Promise.all([RC.leer("usuarios",10),RC.leer("portal_users",10)]);
    const emailDe=(u)=>{ if(!u) return "";
      if(u.email) return String(u.email).trim();
      const p=pu.find(x=>x.email&&[x.crmId,x.id,x._id].some(k=>k&&(U(k)===U(u._id)||U(k)===U(u.id))));
      return p?String(p.email).trim():""; };
    const esDe=(u,a)=>[u._id,u.id,u.crmId,u.grupoAgente,u.catalogoVendedor,u.username].some(k=>k&&U(k)===U(a));
    const com=us.find(u=>esDe(u,agente))||pu.find(u=>esDe(u,agente));
    const eq=U(com&&com.equipo);
    const rolDe=(u)=>String(u.rol||"").toLowerCase();
    const jefes=us.filter(u=>["jefe","crm_jefe"].includes(rolDe(u))&&eq&&U(u.equipo)===eq);
    const dir=us.filter(u=>["director","crm_director"].includes(rolDe(u)));
    const ceo=[...us,...pu].filter(u=>rolDe(u)==="ceo"||U(u._id)==="CEO"||U(u.id)==="CEO");
    const quien=U(quienId);
    const fuera=(u)=>quien&&[u._id,u.id,u.crmId,u.username,u.grupoAgente].some(k=>k&&U(k)===quien);
    const lista=(l,papel)=>l.filter(u=>!fuera(u)).map(u=>({email:emailDe(u),nombre:u.nombre||u.id||u._id,papel})).filter(x=>x.email);
    const para=com&&!fuera(com)?lista([com],"comercial"):[];
    const vistos=new Set(para.map(x=>x.email.toLowerCase()));
    const copias=[...lista(jefes,"jefe de equipo"),...lista(dir,"jefe de ventas"),...lista(ceo,"CEO")]
      .filter(x=>!vistos.has(x.email.toLowerCase())&&(vistos.add(x.email.toLowerCase()),true));
    return {para,copias,nombreComercial:(com&&com.nombre)||agente};
  };
  RC.avisarInstruccion=async(caso,texto,quien,quienId)=>{
    const d=await RC.destinatarios(caso.agente,quienId);
    const to=[...d.para,...d.copias].map(x=>x.email);
    if(!to.length) return d;
    const esc=(t)=>String(t||"").replace(/[<>&]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]));
    const html=`<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#14181F">
      <div style="background:#14181F;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0">
        <div style="font-size:11px;letter-spacing:.08em;opacity:.7;text-transform:uppercase">Plan de recuperación · instrucción</div>
        <div style="font-size:19px;font-weight:800;margin-top:2px">${esc(caso.nombre)}</div></div>
      <div style="border:1px solid #DCE1E7;border-top:none;border-radius:0 0 12px 12px;padding:18px 20px">
        <div style="font-size:12px;color:#6B7684"><b>${esc(quien)}</b> pide a <b>${esc(d.nombreComercial)}</b>:</div>
        <div style="font-size:15px;font-weight:700;margin:4px 0 12px;white-space:pre-wrap">${esc(texto)}</div>
        <div style="font-size:12.5px;color:#3A424E">Cae ${RC.eur(caso.perdido)}${caso.causa?` · causa: ${esc(caso.causa)} · plan: ${esc(caso.accion)}`:" · todavía sin diagnosticar"}.</div>
        ${RC.htmlProductos(RC.prodDe(caso),{max:3,sinSuben:true})}
        <div style="font-size:12px;color:#8A94A0;margin-top:10px">El comercial cuenta lo que haga en el caso. Se revisa en el comité del viernes.
          ${d.copias.length?`<br>Copia a: ${d.copias.map(x=>esc(x.nombre)+" ("+x.papel+")").join(", ")}.`:""}</div>
        <a href="https://crmwikuk.vercel.app/" style="display:inline-block;margin-top:14px;background:#14181F;color:#fff;text-decoration:none;padding:10px 20px;border-radius:9px;font-size:13px;font-weight:700">Abrir el portal</a>
      </div></div>`;
    try{ await fetch("/api/send-email",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({to,subject:`📌 ${quien} → ${d.nombreComercial}: ${caso.nombre}`,html})}); d.enviado=true; }
    catch(e){ d.enviado=false; }
    return d;
  };
  // Pedir el diagnóstico de varios casos de un comercial en un solo correo
  RC.pedirDiagnosticos=async(agente,casos,quien,quienId,horas)=>{
    horas=horas||48;
    const d=await RC.destinatarios(agente,quienId);
    const ahora=new Date(); const limite=new Date(ahora.getTime()+horas*3600000);
    const fl=limite.toLocaleDateString("es-ES",{weekday:"long",day:"numeric",month:"long"});
    const sem=RC.semanaISO(ahora);
    const txt=`Diagnostica antes del ${fl}: por qué cae, qué vas a hacer, para cuándo y cuánto vas a recuperar.`;
    for(const c of casos){
      const hist=(c.historial||[]).concat([{sem,fecha:ahora.toISOString(),por:quien,sistema:"Pide diagnóstico en "+horas+" h"}]);
      const campos={historial:hist,instruccion:txt,instruccionPor:quien,instruccionEn:ahora.toISOString(),instruccionLeida:false,
        diagnosticoPedidoEn:ahora.toISOString(),diagnosticoPedidoPor:quien,diagnosticoLimite:limite.toISOString()};
      try{ await RC.guardar(c._id,campos); Object.assign(c,campos); }catch(e){}
    }
    const to=[...d.para,...d.copias].map(x=>x.email);
    if(to.length){
      const esc=(t)=>String(t||"").replace(/[<>&]/g,x=>({"<":"&lt;",">":"&gt;","&":"&amp;"}[x]));
      const tot=casos.reduce((t,c)=>t+num(c.perdido),0);
      const html=`<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;color:#14181F">
        <div style="background:#14181F;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0">
          <div style="font-size:11px;letter-spacing:.08em;opacity:.7;text-transform:uppercase">Plan de recuperación · diagnóstico</div>
          <div style="font-size:19px;font-weight:800;margin-top:2px">${casos.length} cliente${casos.length===1?"":"s"} · ${RC.eur(tot)} en juego</div></div>
        <div style="border:1px solid #DCE1E7;border-top:none;border-radius:0 0 12px 12px;padding:18px 20px">
          <div style="font-size:14px;margin-bottom:10px"><b>${esc(quien)}</b> pide a <b>${esc(d.nombreComercial)}</b> el diagnóstico de estos clientes
            <b>antes del ${esc(fl)}</b>: por qué cae, qué vas a hacer, para cuándo y cuánto vas a recuperar.</div>
          ${casos.slice().sort((a,b)=>num(b.perdido)-num(a.perdido)).map(c=>`<div style="border:1px solid #EEF1F5;border-left:3px solid ${RC.NIVEL_COL[RC.nivelDe(c).nivel]};border-radius:6px;padding:8px 10px;margin:6px 0">
            <div style="display:flex;justify-content:space-between;gap:8px"><b style="font-size:13px">${esc(c.nombre)}</b>
              <span style="font-size:12.5px;font-weight:800;color:#C2263D;white-space:nowrap">−${RC.eur(c.perdido)}</span></div>
            <div style="font-size:11.5px;color:#6B7684">${esc(c.motivo||"")}</div>
            ${RC.htmlProductos(RC.prodDe(c),{max:3,sinSuben:true})}</div>`).join("")}
          <div style="font-size:12.5px;margin-top:12px">Se hace en el portal → <b>🚨 Plan de recuperación</b> → cada cliente → <b>Diagnosticar ahora</b>. Tarda un minuto por cliente.</div>
          ${d.copias.length?`<div style="font-size:11.5px;color:#8A94A0;margin-top:8px">Copia a: ${d.copias.map(x=>esc(x.nombre)+" ("+x.papel+")").join(", ")}.</div>`:""}
          <a href="https://crmwikuk.vercel.app/" style="display:inline-block;margin-top:14px;background:#14181F;color:#fff;text-decoration:none;padding:10px 20px;border-radius:9px;font-size:13px;font-weight:700">Abrir el portal</a>
        </div></div>`;
      try{ await fetch("/api/send-email",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({to,subject:`📨 ${quien} → ${d.nombreComercial}: diagnóstico de ${casos.length} cliente${casos.length===1?"":"s"} antes del ${fl}`,html})}); }catch(e){}
    }
    return d;
  };
  // Guarda el diagnóstico (mismos campos que el parte semanal)
  RC.guardarDiagnostico=async(c,r,por)=>{
    const ahora=new Date().toISOString();
    const mg=r.accion==="Oferta de vuelta"&&r.margenOferta!==""&&r.margenOferta!=null?Number(String(r.margenOferta).replace(",",".")):null;
    const campos={causa:r.causa,causaNota:r.causaNota||"",accion:r.accion,accionNota:r.accionNota||"",
      fechaObjetivo:r.fechaObjetivo,eurosObjetivo:Number(r.eurosObjetivo)||0,margenOferta:mg,
      necesitaAprobacion:(mg!=null&&mg<RC.UMBRAL.margenMin)?"margen":"",margenAprobado:"",
      estado:"diagnosticado",diagnosticadoEn:ahora,diagnosticadoPor:por,actualizado:ahora,
      historial:(c.historial||[]).concat([{sem:RC.semanaISO(new Date()),fecha:ahora,por,sistema:`Diagnóstico: ${r.causa} · plan: ${r.accion}`}])};
    await RC.guardar(c._id,campos); Object.assign(c,campos); return c;
  };
  // Aviso genérico de una instrucción del jefe o del CEO (partes, objetivos)
  RC.avisarGenerico=async(o)=>{
    const d=await RC.destinatarios(o.agente,o.quienId);
    const to=[...d.para,...d.copias].map(x=>x.email);
    if(!to.length) return d;
    const esc=(t)=>String(t||"").replace(/[<>&]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]));
    const html=`<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#14181F">
      <div style="background:#14181F;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0">
        <div style="font-size:11px;letter-spacing:.08em;opacity:.7;text-transform:uppercase">${esc(o.etiqueta||"Instrucción")}</div>
        <div style="font-size:19px;font-weight:800;margin-top:2px">${esc(o.titulo)}</div></div>
      <div style="border:1px solid #DCE1E7;border-top:none;border-radius:0 0 12px 12px;padding:18px 20px">
        <div style="font-size:12px;color:#6B7684"><b>${esc(o.quien)}</b> pide a <b>${esc(d.nombreComercial)}</b>:</div>
        <div style="font-size:15px;font-weight:700;margin:4px 0 12px;white-space:pre-wrap">${esc(o.texto)}</div>
        ${o.detalle?`<div style="font-size:12.5px;color:#3A424E">${esc(o.detalle)}</div>`:""}
        <div style="font-size:12px;color:#8A94A0;margin-top:10px">${esc(o.pie||"Queda como objetivo de la semana en el CRM y se revisa en el comité del viernes.")}
          ${d.copias.length?`<br>Copia a: ${d.copias.map(x=>esc(x.nombre)+" ("+x.papel+")").join(", ")}.`:""}</div>
        <a href="https://crmwikuk.vercel.app/" style="display:inline-block;margin-top:14px;background:#14181F;color:#fff;text-decoration:none;padding:10px 20px;border-radius:9px;font-size:13px;font-weight:700">Abrir el portal</a>
      </div></div>`;
    try{ await fetch("/api/send-email",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({to,subject:`📌 ${o.quien} → ${d.nombreComercial}: ${o.titulo}`,html})}); d.enviado=true; }catch(e){}
    return d;
  };
  RC.textoAviso=(d)=>!d||(!d.para.length&&!d.copias.length)?"Guardada en el caso. No encuentro correos: la verá en el panel y en su parte."
    :`Enviada a ${d.para.length?d.para.map(x=>x.nombre).join(", "):"(sin correo del comercial)"}${d.copias.length?" · copia a "+d.copias.map(x=>x.nombre+" ("+x.papel+")").join(", "):""}.`;

  // Resumen para informes (jefe, CEO, comité)
  RC.resumen=(casos)=>{
    const ab=casos.filter(RC.abierto);
    const sem=RC.semanaISO(new Date());
    const hoyMes=new Date().getMonth();
    const r={abiertos:ab.length,
      enRiesgo:ab.reduce((t,c)=>t+num(c.perdido),0),
      sinPlan:ab.filter(c=>!RC.tienePlan(c)&&c.estado!=="propuesta_archivo").length,
      parados:ab.filter(c=>{const d=RC.dias(c.ultimaAccion||c.abierto);return d!=null&&d>RC.UMBRAL.diasSinAccion;}).length,
      nivel3:ab.filter(c=>num(c.nivel)>=3).length,
      nivel2:ab.filter(c=>num(c.nivel)===2).length,
      propuestas:ab.filter(c=>c.estado==="propuesta_archivo").length,
      margenPend:ab.filter(c=>c.necesitaAprobacion==="margen").length,
      recuperados:casos.filter(c=>c.estado==="recuperado").length,
      recuperadosEur:casos.filter(c=>c.estado==="recuperado").reduce((t,c)=>t+num(c.perdido),0),
      recuperadosMes:casos.filter(c=>c.estado==="recuperado"&&new Date(c.recuperadoEn).getMonth()===hoyMes).length,
      archivados:casos.filter(c=>c.estado==="archivado").length,
      nuevosSemana:casos.filter(c=>num(c.semanaApertura)===sem).length,
      causas:{}};
    ab.forEach(c=>{ if(c.causa) r.causas[c.causa]=(r.causas[c.causa]||0)+num(c.perdido); });
    return r;
  };

  g.RC=RC;
})(typeof window!=="undefined"?window:globalThis);
