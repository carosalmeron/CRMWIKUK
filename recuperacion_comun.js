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
      const dice=caen.length===1?"Este artículo cae":"Estos "+caen.length+" artículos caen";
      cuadre=`<div style="font-size:11.5px;color:#6B7684;margin-top:5px;line-height:1.4">`
        +(pierde-gana<=tot+Math.max(50,tot*0.02)
          ? `${dice} <b>${RC.eur(pierde)}</b>${gana?`, lo que compra más compensa ${RC.eur(gana)}`:""}. El cliente cae <b>${RC.eur(tot)}</b> en total`
            +(resto>Math.max(50,tot*0.02)?`: los otros <b>${RC.eur(resto)}</b> vienen de artículos más pequeños o de abonos.`:".")
          : `${dice} <b>${RC.eur(pierde)}</b>, pero otros artículos compensan ${RC.eur(-resto)}: el cliente cae <b>${RC.eur(tot)}</b> en total.`)
        +`</div>`;
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

  // ══ Estrategias (las mismas del CRM, colección «estrategias») ═════════
  // Formato idéntico al del CRM (arrays y mapas nativos de Firestore), para
  // que se vean y se aprueben igual desde la pestaña Estrategias.
  const ser=(v)=>{
    if(v===null||v===undefined) return {nullValue:null};
    if(typeof v==="boolean") return {booleanValue:v};
    if(typeof v==="number") return {doubleValue:v};
    if(typeof v==="string") return {stringValue:v};
    if(Array.isArray(v)) return {arrayValue:{values:v.map(ser)}};
    if(typeof v==="object") return {mapValue:{fields:Object.fromEntries(Object.entries(v).map(([k,x])=>[k,ser(x)]))}};
    return {stringValue:String(v)};
  };
  const des=(f)=>{
    if(!f) return null;
    if(f.arrayValue) return (f.arrayValue.values||[]).map(des);
    if(f.mapValue){ const o={}; for(const [k,x] of Object.entries(f.mapValue.fields||{})) o[k]=des(x); return o; }
    return val(f);
  };
  RC.leerProfundo=async(col)=>{
    const t=[]; let tok=null,v=0;
    do{
      const r=await fetch(`${RC.FB}/${col}?pageSize=300`+(tok?`&pageToken=${encodeURIComponent(tok)}`:""),{cache:"no-store"});
      if(!r.ok) break;
      const j=await r.json();
      for(const d of j.documents||[]){ const o={_id:decodeURIComponent(d.name.split("/").pop())};
        for(const [k,x] of Object.entries(d.fields||{})) o[k]=des(x); t.push(o); }
      tok=j.nextPageToken||null; v++;
    }while(tok&&v<60);
    return t;
  };
  RC.guardarEn=async(col,id,campos,parcial)=>{
    const f={}; for(const [k,v] of Object.entries(campos)) if(k!=="_id") f[k]=ser(v);
    const qs=parcial?"?"+Object.keys(f).map(k=>"updateMask.fieldPaths="+encodeURIComponent(k)).join("&"):"";
    const r=await fetch(`${RC.FB}/${col}/${encodeURIComponent(id)}${qs}`,{method:"PATCH",
      headers:{"Content-Type":"application/json"},body:JSON.stringify({fields:f})});
    if(!r.ok) throw new Error("HTTP "+r.status);
  };
  // Quién es quién alrededor de un comercial (ids del CRM)
  RC.cadenaDe=async(agente)=>{
    if(!RC._us) RC._us=await RC.leer("usuarios",10);
    const us=RC._us, rol=(u)=>String(u.rol||"").toLowerCase();
    const esDe=(u)=>[u._id,u.id,u.grupoAgente,u.catalogoVendedor,u.username].some(k=>k&&ARR(k)===ARR(agente));
    const ag=us.find(u=>esDe(u)&&!["jefe","crm_jefe","director","crm_director","ceo","admin"].includes(rol(u)))||us.find(esDe)||null;
    const eq=ARR(ag&&ag.equipo);
    const P=(u)=>u?{id:u.id||u._id,nombre:u.nombre||u.id||u._id}:null;
    return {ag:ag?Object.assign(P(ag),{equipo:ag.equipo||""}):{id:agente,nombre:agente,equipo:""},
      resp:P(us.find(u=>["jefe","crm_jefe"].includes(rol(u))&&eq&&ARR(u.equipo)===eq)),
      dir:P(us.find(u=>["director","crm_director"].includes(rol(u)))),
      ceo:P(us.find(u=>rol(u)==="ceo"||ARR(u.id||u._id)==="CEO"))};
  };
  // Límites de descuento por nivel, los mismos que el CRM
  RC.LIM_DTO={jefe:10,director:15,ceo:100};
  RC.dtoDe=(pa,po)=>num(pa)>0?Math.round((num(pa)-num(po))/num(pa)*100):0;
  // por: {nombre, nivel:"comercial"|"jefe"|"director"|"ceo"}
  RC.crearEstrategia=async(caso,l,nota,por)=>{
    const cad=await RC.cadenaDe(caso.agente);
    const hoy=new Date(), hoyS=hoy.toLocaleDateString("es-ES");
    const dto=RC.dtoDe(l.precioActual,l.precioOferta);
    let estado="aprobada", pend=null, cadena=[];
    const nivel=por.nivel;
    if(nivel==="comercial"){
      estado="pendiente_aprobacion"; pend=cad.resp||cad.dir;
      cadena=[{rol:"responsable",id:cad.resp&&cad.resp.id,nombre:cad.resp&&cad.resp.nombre,estado:"pendiente",limiteDto:10}];
      if(dto>10) cadena.push({rol:"jefe_ventas",id:cad.dir&&cad.dir.id,nombre:cad.dir&&cad.dir.nombre,estado:"pendiente",limiteDto:15});
      if(dto>15) cadena.push({rol:"ceo",id:cad.ceo&&cad.ceo.id,nombre:cad.ceo&&cad.ceo.nombre,estado:"pendiente",limiteDto:100});
    } else if(dto>(RC.LIM_DTO[nivel]||0)){
      // El jefe puede crearla, pero si el descuento pasa de su límite la aprueba el de arriba
      estado="pendiente_aprobacion"; pend=nivel==="jefe"?(dto>15?cad.ceo:cad.dir):cad.ceo;
    } else cadena=[{rol:nivel,nombre:por.nombre,estado:"aprobado",fecha:hoyS}];
    const id="est_rec_"+Date.now()+"_"+Math.random().toString(36).slice(2,5);
    const linea={id:"l1",nombre:l.desc||l.art||"Artículo",codigo:l.art||"",calibre:l.cal||"",
      precioActual:num(l.precioActual),precioOferta:num(l.precioOferta),precioFinal:num(l.precioOferta),
      dto,unidad:l.unidad||"m",cantidad:num(l.cantidad)||0,aprobada:estado==="aprobada"?true:null};
    const doc={id,cliente:caso.nombre,clienteNombre:caso.nombre,clienteId:caso.cliente,
      agente:cad.ag.id,agenteNombre:cad.ag.nombre,equipo:cad.ag.equipo||caso.equipo||"",
      estrategia:(nivel==="comercial"?"Solicitud precio: ":"Precio especial: ")+linea.nombre+(linea.calibre?" "+linea.calibre:"")+" a "+linea.precioOferta+" €/"+linea.unidad,
      texto:"Recuperar "+caso.nombre+": "+linea.nombre,
      descripcion:nota||"",notaJefe:nivel==="comercial"?"":(nota||""),
      maxDescuento:dto,ofertas:[linea],productos:[linea],
      estado,prioridad:"alta",pendienteDe:pend?pend.id:null,pendienteDeNombre:pend?pend.nombre:null,
      cadenaAprobacion:cadena,escaladoA:estado==="pendiente_aprobacion"&&nivel!=="comercial"?(pend&&pend.id):null,
      fechaCreacion:hoy.toISOString(),fechaCreacionStr:hoyS,semana:RC.semanaISO(hoy),
      creadoPor:por.id||por.nombre,creadoPorNombre:por.nombre,solicitudAgente:nivel==="comercial",
      origen:caso._id?"recuperacion":"cierre_equipo",casoId:caso._id||"",
      seguimientos:[{accion:(nivel==="comercial"?"💰 Solicitud desde el plan de recuperación":"🎯 Creada desde el plan de recuperación")+" — "+linea.nombre+" a "+linea.precioOferta+" € (dto "+dto+" %)",fecha:hoyS,por:por.nombre,nota:nota||""}],
      historialEscalado:[{accion:nivel==="comercial"?"💰 Solicitud del comercial — dto "+dto+" %":(estado==="aprobada"?"✅ Creada y aprobada por "+por.nombre:"↑ Creada por "+por.nombre+", supera su límite: la aprueba "+(pend&&pend.nombre)),por:por.nombre,fecha:hoyS}]};
    await RC.guardarEn("estrategias",id,doc);
    // En el caso queda anotado
    const hist=(caso.historial||[]).concat([{sem:RC.semanaISO(hoy),fecha:hoy.toISOString(),por:por.nombre,
      sistema:(nivel==="comercial"?"Pide estrategia: ":"Estrategia: ")+linea.nombre+" a "+linea.precioOferta+" € (dto "+dto+" %)"+(estado==="aprobada"?" · aprobada":" · pendiente de "+(pend&&pend.nombre||"aprobar"))}]);
    const campos={historial:hist};
    if(nivel==="comercial") campos.ultimaAccion=hoy.toISOString();
    if(caso._id){ try{ await RC.guardar(caso._id,campos); Object.assign(caso,campos); }catch(e){} }
    // Aviso por correo
    try{
      if(nivel==="comercial"&&pend){
        await RC.avisarA(pend.id,`💰 ${cad.ag.nombre} pide estrategia: ${caso.nombre}`,
          `<b>${RC.esc(cad.ag.nombre)}</b> pide <b>${RC.esc(linea.nombre)}${linea.calibre?" "+RC.esc(linea.calibre):""}</b> a <b>${linea.precioOferta} €/${linea.unidad}</b> (ahora ${linea.precioActual} €, descuento ${dto} %) para recuperar a <b>${RC.esc(caso.nombre)}</b>, que cae ${RC.eur(caso.perdido)}.${nota?"<br><i>“"+RC.esc(nota)+"”</i>":""}<br><br>Apruébala, elévala o recházala en el portal → 🚨 Plan de recuperación, o en el CRM → Estrategias.`);
      } else if(nivel!=="comercial"){
        await RC.avisarGenerico({agente:caso.agente,quienId:por.id,quien:por.nombre,titulo:caso.nombre,etiqueta:"Estrategia",
          texto:`Precio especial: ${linea.nombre}${linea.calibre?" "+linea.calibre:""} a ${linea.precioOferta} €/${linea.unidad} (descuento ${dto} %).${nota?" "+nota:""}`,
          detalle:estado==="aprobada"?"Está aprobada: ya puedes ofrecerla.":"Pendiente de aprobación de "+(pend&&pend.nombre||"dirección")+".",
          pie:"La tienes en el CRM → Estrategias."});
      }
    }catch(e){}
    return doc;
  };
  RC.esc=(t)=>String(t??"").replace(/[<>&]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]));
  RC.avisarA=async(idUsuario,asunto,cuerpo)=>{
    if(!RC._us) RC._us=await RC.leer("usuarios",10);
    const pu=await RC.leer("portal_users",10);
    const u=RC._us.find(x=>ARR(x.id||x._id)===ARR(idUsuario))||pu.find(x=>ARR(x.crmId||x.id||x._id)===ARR(idUsuario));
    let em=u&&u.email;
    if(!em&&u){ const p=pu.find(x=>x.email&&[x.crmId,x.id,x._id].some(k=>k&&ARR(k)===ARR(u.id||u._id))); em=p&&p.email; }
    if(!em) return false;
    await fetch("/api/send-email",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({to:em,subject:asunto,
      html:`<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#14181F"><div style="background:#14181F;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0;font-size:17px;font-weight:800">${RC.esc(asunto)}</div><div style="border:1px solid #DCE1E7;border-top:none;border-radius:0 0 12px 12px;padding:18px 20px;font-size:14px;line-height:1.5">${cuerpo}<br><a href="https://crmwikuk.vercel.app/" style="display:inline-block;margin-top:14px;background:#14181F;color:#fff;text-decoration:none;padding:10px 20px;border-radius:9px;font-size:13px;font-weight:700">Abrir el portal</a></div></div>`})});
    return true;
  };
  // Resolver: accion "aprobar" | "rechazar" | "elevar"
  RC.resolverEstrategia=async(e,accion,por,nota)=>{
    const hoyS=new Date().toLocaleDateString("es-ES");
    const cad=await RC.cadenaDe(e.agente);
    const ofs=(e.ofertas||[]).map(o=>Object.assign({},o));
    let campos={};
    if(accion==="aprobar"){
      ofs.forEach(o=>{ o.aprobada=true; o.aprobadaPor=por.nombre; });
      campos={estado:"aprobada",ofertas:ofs,aprobadoPor:por.nombre,escaladoA:null,pendienteDe:null,
        resolucion:{tipo:"aprobada",por:por.nombre,rol:por.nivel,fecha:hoyS,nota:nota||""}};
    } else if(accion==="rechazar"){
      ofs.forEach(o=>{ o.aprobada=false; o.rechazadaPor=por.nombre; });
      campos={estado:"sin_exito",ofertas:ofs,pendienteDe:null,
        resolucion:{tipo:"rechazada",por:por.nombre,rol:por.nivel,fecha:hoyS,nota:nota||""}};
    } else {
      const dest=por.nivel==="jefe"?(cad.dir||cad.ceo):cad.ceo;
      campos={estado:"pendiente_aprobacion",escaladoA:dest&&dest.id,pendienteDe:dest&&dest.id,pendienteDeNombre:dest&&dest.nombre};
    }
    campos.historialEscalado=(e.historialEscalado||[]).concat([{accion:accion==="aprobar"?"✅ Aprobada por "+por.nombre
      :accion==="rechazar"?"❌ Rechazada por "+por.nombre:"↑ Elevada a "+(campos.pendienteDeNombre||"dirección"),por:por.nombre,fecha:hoyS,nota:nota||""}]);
    await RC.guardarEn("estrategias",e._id||e.id,campos,true);
    Object.assign(e,campos);
    // Oferta automática al aprobar, como hace el CRM
    if(accion==="aprobar"){
      try{
        const ofId="oferta_est_"+(e._id||e.id)+"_"+Date.now(); const pl=new Date(); pl.setDate(pl.getDate()+30);
        await RC.guardarEn("ofertas",ofId,{id:ofId,clienteNombre:e.cliente||e.clienteNombre||"",clienteId:e.clienteId||"",
          agente:e.agente||"",agenteNombre:e.agenteNombre||"",equipo:e.equipo||"",
          lineas:ofs.map(o=>({producto:o.nombre||"",calibre:o.calibre||"",precio:num(o.precioFinal||o.precioOferta),cantidad:num(o.cantidad),unidad:o.unidad||"m"})),
          estado:"pendiente",desdeEstrategia:e._id||e.id,fechaCreacion:new Date().toISOString(),fechaCreacionStr:hoyS,
          fechaPlazo:pl.toISOString(),notas:"Generada al aprobar la estrategia desde el plan de recuperación"+(nota?". "+nota:""),
          seguimientos:[{accion:"📋 Oferta generada desde estrategia aprobada",fecha:hoyS,por:por.nombre,nota:nota||""}]});
      }catch(x){}
    }
    try{
      const txt=accion==="aprobar"?"✅ Aprobada":accion==="rechazar"?"❌ Rechazada":"↑ Elevada";
      if(accion==="elevar"&&campos.pendienteDe) await RC.avisarA(campos.pendienteDe,`↑ ${por.nombre} te eleva una estrategia: ${e.cliente}`,
        `${RC.esc(e.estrategia||e.texto||"")}. Descuento ${num(e.maxDescuento)} %.${nota?"<br><i>“"+RC.esc(nota)+"”</i>":""}`);
      else await RC.avisarA(e.agente,`${txt}: tu estrategia para ${e.cliente}`,`${RC.esc(e.estrategia||"")}.${nota?"<br><i>“"+RC.esc(nota)+"”</i>":""}${accion==="aprobar"?"<br>Tienes la oferta creada en el CRM.":""}`);
    }catch(x){}
    return e;
  };
  RC.estrategiasDeCaso=(ests,c)=>ests.filter(e=>!e.eliminada&&(e.casoId===c._id||ARR(e.clienteId)===ARR(c.cliente)));
  RC.ESTADO_EST={pendiente_aprobacion:["⏳ Pendiente","#B45309","#FFFBEB"],aprobada:["✅ Aprobada","#15803D","#F0FDF4"],
    sin_exito:["✖ Rechazada","#B91C1C","#FEF2F2"],completada:["✔ Completada","#15803D","#F0FDF4"],pendiente:["⏳ Pendiente","#B45309","#FFFBEB"]};
  // ¿Puede este nivel resolverla? (límite de descuento y a quién está pendiente)
  RC.puedeResolverEst=(e,nivel,miId)=>{
    if(e.estado!=="pendiente_aprobacion") return false;
    if(nivel==="ceo") return true;
    if(nivel==="director") return num(e.maxDescuento)<=RC.LIM_DTO.director;
    if(nivel==="jefe") return num(e.maxDescuento)<=RC.LIM_DTO.jefe;
    return false;
  };
  // ══ Ofertas (colección «ofertas» del CRM) ═══════════════════════════
  // Límites de descuento del comercial en una oferta: los del CRM
  // (configuracion/general → limites_dto; por defecto 4 / 10 / 15 %).
  RC.limitesDto=async()=>{
    if(RC._lim) return RC._lim;
    RC._lim={agente:4,jefe:10,director:15};
    try{ const r=await fetch(`${RC.FB}/configuracion/general`); if(r.ok){ const j=await r.json();
      const l=j.fields&&j.fields.limites_dto&&j.fields.limites_dto.mapValue&&j.fields.limites_dto.mapValue.fields;
      if(l) ["agente","jefe","director"].forEach(k=>{ const v=l[k]&&(l[k].doubleValue??l[k].integerValue); if(v!=null) RC._lim[k]=Number(v); }); } }catch(e){}
    return RC._lim;
  };
  // Si el descuento entra en su límite se crea la oferta; si no, se convierte
  // en petición de estrategia (como hace el formulario de ofertas del CRM).
  RC.crearOferta=async(caso,l,nota,por)=>{
    const lim=await RC.limitesDto();
    const tope=por.nivel==="ceo"?100:por.nivel==="director"?lim.director:por.nivel==="jefe"?lim.jefe:lim.agente;
    const dto=RC.dtoDe(l.precioActual,l.precioOferta);
    if(num(l.precioActual)>0&&dto>tope){
      const e=await RC.crearEstrategia(caso,l,(nota?nota+" · ":"")+"Oferta con "+dto+" % de descuento: supera el límite del "+tope+" %",
        Object.assign({},por,{nivel:por.nivel==="comercial"?"comercial":por.nivel}));
      return {tipo:"estrategia",doc:e,dto,tope};
    }
    const cad=await RC.cadenaDe(caso.agente);
    const hoy=new Date(), hoyS=hoy.toLocaleDateString("es-ES",{day:"2-digit",month:"2-digit",year:"2-digit"});
    const plazo=new Date(hoy.getTime()+5*86400000);
    const id="oferta_rec_"+Date.now()+"_"+Math.random().toString(36).slice(2,5);
    const doc={id,clienteNombre:caso.nombre,clienteCodigo:caso.cliente,clienteId:caso.cliente,
      agente:cad.ag.id,agenteNombre:cad.ag.nombre,equipo:cad.ag.equipo||caso.equipo||"",
      lineas:[{id:"l1",producto:l.desc||l.art||"",descripcion:l.desc||"",codigo:l.art||"",calibre:l.cal||"",
        precio:num(l.precioOferta),precioBase:num(l.precioActual)||"",dto:num(l.precioActual)>0?dto:"",
        unidad:"€/"+(l.unidad||"m"),cantidad:num(l.cantidad)||0,notas:nota||""}],
      estado:"pendiente",fechaCreacion:hoy.toISOString(),fechaCreacionStr:hoyS,fechaPlazo:plazo.toISOString(),
      notaInicial:"Desde el plan de recuperación",notas:nota||"",origen:"recuperacion",casoId:caso._id||"",
      seguimientos:[{accion:"Oferta enviada",fecha:hoyS,por:por.nombre,nota:"Plan de recuperación"+(nota?" · "+nota:"")}]};
    await RC.guardarEn("ofertas",id,doc);
    if(caso._id){
      const hist=(caso.historial||[]).concat([{sem:RC.semanaISO(hoy),fecha:hoy.toISOString(),por:por.nombre,
        sistema:`Oferta enviada: ${doc.lineas[0].producto} a ${num(l.precioOferta)} €/${l.unidad||"m"}${num(l.precioActual)>0?" (dto "+dto+" %)":""}`}]);
      try{ await RC.guardar(caso._id,{historial:hist,ultimaAccion:hoy.toISOString()}); caso.historial=hist; caso.ultimaAccion=hoy.toISOString(); }catch(e){}
    }
    return {tipo:"oferta",doc,dto,tope};
  };
  RC.htmlOferta=(o)=>{
    const l=(o.lineas||[])[0]||{};
    return `<div style="border:1px solid #BFDBFE;background:#EFF6FF;border-radius:12px;padding:10px 12px;margin:8px 0">
      <b style="font-size:13.5px">📨 Oferta: ${RC.esc(l.producto||"")}${l.calibre?" · "+RC.esc(l.calibre):""}</b>
      <div style="font-size:13px;margin-top:3px">${l.precioBase?RC.esc(l.precioBase)+" € → ":""}<b style="color:#1D4ED8">${RC.esc(l.precio)} ${RC.esc(l.unidad||"")}</b>${l.dto!==""&&l.dto!=null?" · descuento "+RC.esc(l.dto)+" %":""}</div>
      <div style="font-size:12px;color:#475569;margin-top:2px">Registrada en el CRM → Ofertas · seguimiento en 5 días</div></div>`;
  };

  // ¿Le toca verla y decidir (aprobar si puede, si no elevar o rechazar)?
  RC.meTocaEst=(e,nivel,miId)=>{
    if(e.estado!=="pendiente_aprobacion") return false;
    const dest=ARR(e.escaladoA||"");
    if(nivel==="ceo") return true;
    if(nivel==="director") return !dest||dest!=="CEO"&&!/^CEO/.test(dest)||ARR(e.pendienteDe)===ARR(miId);
    if(nivel==="jefe") return !dest||dest===ARR(miId);
    return false;
  };
  // Formulario (HTML) para pedir o crear una estrategia sobre un artículo
  RC.formEstrategia=(pref,arts,texto)=>{
    const ops=(arts||[]).map((a,i)=>`<option value="${i}">${RC.esc(a.desc||a.art)}${a.cal?" · "+RC.esc(a.cal):""} (${RC.eur(a.ant)} → ${RC.eur(a.act)})</option>`).join("");
    return `<div style="display:grid;gap:7px;background:#F5F3FF;border:1px solid #DDD6FE;border-radius:12px;padding:12px;margin-top:8px">
      <div style="font-weight:800;color:#5B21B6">${texto||"💶 Estrategia de precio"}</div>
      <select id="${pref}_art" onchange="document.getElementById('${pref}_otro').style.display=this.value==='otro'?'block':'none'" style="padding:9px;border:1.5px solid #DDD6FE;border-radius:9px;font:inherit;font-size:14px">
        ${ops}<option value="otro">➕ Otro artículo…</option></select>
      <input id="${pref}_otro" placeholder="Artículo (nombre o código)" style="display:${ops?"none":"block"};padding:9px;border:1.5px solid #DDD6FE;border-radius:9px;font:inherit;font-size:14px">
      <div style="display:grid;grid-template-columns:1fr 1fr 80px;gap:6px">
        <label style="font-size:12px;color:#6B7280">Precio ahora<input id="${pref}_pa" type="number" step="0.01" style="width:100%;padding:9px;border:1.5px solid #DDD6FE;border-radius:9px;font-size:14px"></label>
        <label style="font-size:12px;color:#6B7280">Precio que pide<input id="${pref}_po" type="number" step="0.01" style="width:100%;padding:9px;border:1.5px solid #7C3AED;border-radius:9px;font-size:14px;font-weight:700"></label>
        <label style="font-size:12px;color:#6B7280">€ por<select id="${pref}_ud" style="width:100%;padding:9px;border:1.5px solid #DDD6FE;border-radius:9px;font-size:14px"><option>m</option><option>kg</option><option>ud</option><option>mazo</option></select></label>
      </div>
      <textarea id="${pref}_nota" placeholder="Por qué (qué le ofrece la competencia, volumen, plazo…)" style="min-height:52px;padding:9px;border:1.5px solid #DDD6FE;border-radius:9px;font:inherit;font-size:14px"></textarea>
    </div>`;
  };
  RC.leerFormEstrategia=(pref,arts)=>{
    const v=(k)=>{ const el=document.getElementById(pref+"_"+k); return el?String(el.value||"").trim():""; };
    const sel=v("art"); let a=sel==="otro"||sel===""?null:(arts||[])[Number(sel)];
    if(!a) a={art:"",desc:v("otro"),cal:""};
    return {art:a.art,desc:a.desc,cal:a.cal,precioActual:Number(v("pa").replace(",","."))||0,
      precioOferta:Number(v("po").replace(",","."))||0,unidad:v("ud")||"m",nota:v("nota")};
  };
  RC.htmlEstrategia=(e,botones)=>{
    const [t,c,bg]=RC.ESTADO_EST[e.estado]||["📋 "+(e.estado||""),"#475569","#F8FAFC"];
    const o=(e.ofertas||[])[0]||{};
    return `<div style="border:1px solid #E5E7EB;border-radius:12px;padding:10px 12px;margin:8px 0;background:#fff">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap">
        <b style="font-size:13.5px">💶 ${RC.esc(o.nombre||e.estrategia||"Estrategia")}${o.calibre?" · "+RC.esc(o.calibre):""}</b>
        <span style="font-size:11.5px;font-weight:800;color:${c};background:${bg};border-radius:99px;padding:3px 9px">${t}${e.estado==="pendiente_aprobacion"&&e.pendienteDeNombre?" · "+RC.esc(e.pendienteDeNombre):""}</span></div>
      <div style="font-size:13px;margin-top:4px">${o.precioActual?RC.esc(o.precioActual)+" € → ":""}<b style="color:#6D28D9">${RC.esc(o.precioFinal||o.precioOferta||"")} €/${RC.esc(o.unidad||"m")}</b> · descuento ${num(e.maxDescuento)} %</div>
      <div style="font-size:12px;color:#6B7280;margin-top:2px">${e.solicitudAgente?"Lo pide "+RC.esc(e.agenteNombre||e.agente):"Creada por "+RC.esc(e.creadoPorNombre||"")} · ${RC.esc(e.fechaCreacionStr||"")}${e.descripcion?" · “"+RC.esc(e.descripcion)+"”":""}</div>
      ${botones||""}</div>`;
  };

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
