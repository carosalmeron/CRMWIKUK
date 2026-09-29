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
  RC.VERSION="20260929c";
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
  RC.leerUno=async(id)=>{ const r=await fetch(`${RC.FB}/${RC.COL}/${encodeURIComponent(id)}`,{cache:"no-store"});
    if(!r.ok) return null; return RC.normaliza(RC.desdeFB(await r.json())); };
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
    // El email del comercial puede estar en cualquiera de sus fichas (CRM o portal)
    let para=com&&!fuera(com)?lista([com],"comercial"):[];
    if(com&&!fuera(com)&&!para.length){
      const otra=[...us,...pu].find(u=>esDe(u,agente)&&String(u.email||"").includes("@"));
      if(otra) para=[{email:String(otra.email).trim(),nombre:com.nombre||agente,papel:"comercial"}];
    }
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
    :`Enviada a ${d.para.length?d.para.map(x=>x.nombre).join(", "):"(al comercial no le llega: "+(d.nombreComercial||"")+" no tiene email; ponlo en Admin → Usuarios → 📧 Email)"}${d.copias.length?" · copia a "+d.copias.map(x=>x.nombre+" ("+x.papel+")").join(", "):""}.`;

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
  RC.dtoDe=(pa,po)=>num(pa)>0?Math.round((num(pa)-num(po))/num(pa)*1000)/10:0;
  // por: {nombre, nivel:"comercial"|"jefe"|"director"|"ceo"}
  RC.crearEstrategia=async(caso,l,nota,por)=>{
    const cad=await RC.cadenaDe(caso.agente);
    const hoy=new Date(), hoyS=hoy.toLocaleDateString("es-ES");
    const dto=RC.dtoDe(l.precioActual,l.precioOferta);
    let estado="aprobada", pend=null, cadena=[];
    const nivel=por.nivel;
    if(nivel==="comercial"){
      estado="pendiente_aprobacion";
      // (sep 2026) Va directo a quien puede aprobar ese descuento (el jefe se entera por copia)
      pend=dto>RC.LIM_DTO.director?(cad.ceo||cad.dir||cad.resp):dto>RC.LIM_DTO.jefe?(cad.dir||cad.ceo||cad.resp):(cad.resp||cad.dir);
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
      dto,unidad:l.unidad||"m",cantidad:num(l.cantidad)||0,aprobada:estado==="aprobada"?true:null,
      precioBase:num(l.precioBase)||"",dtoTarifaCliente:l.dtoCliente!=null?l.dtoCliente:"",
      dtoTotal:num(l.precioBase)>0?RC.dtoDe(l.precioBase,l.precioOferta):""};
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
    if(estado==="aprobada") doc.fechaAprobacion=hoy.toISOString();
    await RC.guardarEn("estrategias",id,doc);
    if(estado==="aprobada") await RC.ofertaDeEstrategia(doc,por,nota);
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
        if(cad.resp&&pend.id!==cad.resp.id) await RC.avisarA(cad.resp.id,`💰 Copia: ${cad.ag.nombre} pide estrategia: ${caso.nombre}`,
          `Pide <b>${RC.esc(linea.nombre)}</b> a <b>${linea.precioOferta} €/${linea.unidad}</b> (${dto} % sobre su tarifa). Pasa tu límite: la decide <b>${RC.esc(pend.nombre)}</b>. Te llega por copia.`);
      } else if(nivel!=="comercial"){
        await RC.avisarGenerico({agente:caso.agente,quienId:por.id,quien:por.nombre,titulo:caso.nombre,etiqueta:"Estrategia",
          texto:`Precio especial: ${linea.nombre}${linea.calibre?" "+linea.calibre:""} a ${linea.precioOferta} €/${linea.unidad} (descuento ${dto} %).${nota?" "+nota:""}`,
          detalle:estado==="aprobada"?"Está aprobada: ya puedes ofrecerla.":"Pendiente de aprobación de "+(pend&&pend.nombre||"dirección")+".",
          pie:"La tienes en el CRM → Estrategias."});
      }
    }catch(e){}
    return doc;
  };
  // Oferta en el CRM cuando una estrategia queda aprobada (igual que el CRM)
  RC.ofertaDeEstrategia=async(e,por,nota)=>{
    try{
      const hoyS=new Date().toLocaleDateString("es-ES");
      const ofId="oferta_est_"+(e._id||e.id)+"_"+Date.now(); const pl=new Date(); pl.setDate(pl.getDate()+30);
      await RC.guardarEn("ofertas",ofId,{id:ofId,clienteNombre:e.cliente||e.clienteNombre||"",clienteId:e.clienteId||"",clienteCodigo:e.clienteId||"",
        agente:e.agente||"",agenteNombre:e.agenteNombre||"",equipo:e.equipo||"",
        lineas:(e.ofertas||[]).map(o=>({producto:o.nombre||"",codigo:o.codigo||"",calibre:o.calibre||"",precio:num(o.precioFinal||o.precioOferta),
          precioBase:num(o.precioActual)||"",dto:num(o.dto)||"",cantidad:num(o.cantidad),unidad:o.unidad||"m"})),
        estado:"pendiente",desdeEstrategia:e._id||e.id,casoId:e.casoId||"",origen:"recuperacion",
        fechaCreacion:new Date().toISOString(),fechaCreacionStr:hoyS,fechaPlazo:pl.toISOString(),
        notas:"Generada al aprobar la estrategia desde el plan de recuperación"+(nota?". "+nota:""),
        seguimientos:[{accion:"📋 Oferta generada desde estrategia aprobada",fecha:hoyS,por:por.nombre,nota:nota||""}]});
      e.ofertaGenerada=ofId;
      await RC.guardarEn("estrategias",e._id||e.id,{ofertaGenerada:ofId},true);
    }catch(x){}
  };
  // ── La semana siguiente: ¿la estrategia aprobada ha acabado en pedido? ──
  // "pedido" y "ko" la cierran como en el CRM (completada / sin_exito);
  // "pendiente" deja constancia de que sigue viva esa semana.
  RC.MOTIVOS_KO=[["sigue_caro","💸 Sigue caro"],["no_interesa","🚫 No le interesa"],["compro_otro","🏁 Compró a otro"],["otro","📋 Otro motivo"]];
  RC.estAbierta=(e)=>e.estado==="aprobada"&&!e.cierreFinal&&!e.eliminada;
  RC.lunesDe=(d)=>{ const x=new Date(d); x.setHours(0,0,0,0); x.setDate(x.getDate()-((x.getDay()+6)%7)); return x; };
  // Aprobada antes de esta semana → toca decir qué ha pasado
  RC.tocaResultado=(e,hoy)=>{
    if(!RC.estAbierta(e)) return false;
    const f=RC.fechaAprob(e);
    if(f>=RC.lunesDe(hoy||new Date()).getTime()) return false;
    const s=e.seguimientoSemanal; return !(s&&s.semana===RC.semanaISO(hoy||new Date()));
  };
  RC.resultadoEstrategia=async(e,res,por,nota,subTipo)=>{
    const hoy=new Date(), hoyS=hoy.toLocaleDateString("es-ES"), sem=RC.semanaISO(hoy);
    const lbl=res==="pedido"?"✅ PEDIDO confirmado":res==="ko"?"❌ KO — "+((RC.MOTIVOS_KO.find(m=>m[0]===subTipo)||[,"sin éxito"])[1]):"⏳ Sigue pendiente (semana "+sem+")";
    const seg={accion:lbl,fecha:hoyS,por:por.nombre,nota:nota||""};
    let campos={seguimientos:(e.seguimientos||[]).concat([seg]),seguimientoSemanal:{semana:sem,estado:res,fecha:hoy.toISOString(),nota:nota||"",por:por.nombre}};
    if(res==="pedido") Object.assign(campos,{estado:"completada",resultado:"exito",fechaCierre:hoy.toISOString(),
      cierreFinal:{por:por.nombre,fecha:hoyS,resultado:"pedido",nota:nota||""},resolucion:Object.assign({},e.resolucion||{},{tipo:"pedido",fecha:hoyS,por:por.nombre,nota:nota||""})});
    if(res==="ko") Object.assign(campos,{estado:"sin_exito",resultado:"sin_exito",fechaCierre:hoy.toISOString(),
      cierreFinal:{por:por.nombre,fecha:hoyS,resultado:"ko",subTipo:subTipo||"otro",nota:nota||""},resolucion:Object.assign({},e.resolucion||{},{tipo:"ko",subTipo:subTipo||"otro",fecha:hoyS,por:por.nombre,nota:nota||""})});
    if(res!=="pendiente") campos.historialEscalado=(e.historialEscalado||[]).concat([{accion:lbl,por:por.nombre,fecha:hoyS,nota:nota||""}]);
    await RC.guardarEn("estrategias",e._id||e.id,campos,true);
    Object.assign(e,campos);
    const ofId=e.ofertaGenerada||e.desdeOferta;
    if(ofId&&res!=="pendiente"){
      try{ await RC.guardarEn("ofertas",ofId,{estrategiaResultado:res==="pedido"?"pedido":subTipo==="sigue_caro"?"sigue_caro":"ko",estrategiaCierre:hoyS,estrategiaNota:nota||"",
        estado:res==="pedido"?"pedido":subTipo==="sigue_caro"?"caro":"ko"},true); }catch(x){}
    }
    if(e.casoId){
      try{ const c=await RC.leerUno(e.casoId);
        const hist=((c&&c.historial)||[]).concat([{sem,fecha:hoy.toISOString(),por:por.nombre,sistema:"Estrategia "+((e.ofertas||[])[0]||{}).nombre+": "+lbl+(nota?" · "+nota:"")}]);
        await RC.guardar(e.casoId,{historial:hist,ultimaAccion:hoy.toISOString()}); }catch(x){}
    }
    if(res!=="pendiente"){
      try{ const cad=await RC.cadenaDe(e.agente);
        const cuerpo=`<b>${RC.esc(cad.ag.nombre)}</b>: ${RC.esc(e.estrategia||"")}<br>${lbl}${nota?"<br><i>“"+RC.esc(nota)+"”</i>":""}`;
        if(cad.resp) await RC.avisarA(cad.resp.id,`${res==="pedido"?"✅ Pedido":"❌ Sin éxito"}: ${e.cliente}`,cuerpo); }catch(x){}
    }
    return e;
  };
  RC.esc=(t)=>String(t??"").replace(/[<>&]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]));
  RC.avisarA=async(idUsuario,asunto,cuerpo)=>{
    if(!RC._us) RC._us=await RC.leer("usuarios",10);
    const pu=await RC.leer("portal_users",10);
    const u=RC._us.find(x=>ARR(x.id||x._id)===ARR(idUsuario))||pu.find(x=>ARR(x.crmId||x.id||x._id)===ARR(idUsuario));
    let em=u&&u.email;
    if(!em&&u){ const p=pu.find(x=>x.email&&[x.crmId,x.id,x._id].some(k=>k&&ARR(k)===ARR(u.id||u._id))); em=p&&p.email; }
    // (sep 2026) Si no, cualquier ficha (CRM o portal) de esa persona que tenga email
    if(!em){ const ks=[idUsuario,u&&u.id,u&&u._id,u&&u.grupoAgente,u&&u.username,u&&u.nombre].filter(Boolean).map(ARR);
      const o=[...RC._us,...pu].find(x=>String(x.email||"").includes("@")&&[x._id,x.id,x.crmId,x.grupoAgente,x.catalogoVendedor,x.username].some(k=>k&&ks.includes(ARR(k))));
      em=o&&o.email; }
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
      campos={estado:"aprobada",ofertas:ofs,aprobadoPor:por.nombre,escaladoA:null,pendienteDe:null,fechaAprobacion:new Date().toISOString(),
        resolucion:{tipo:"aprobada",por:por.nombre,rol:por.nivel,fecha:hoyS,nota:nota||""}};
    } else if(accion==="rechazar"){
      ofs.forEach(o=>{ o.aprobada=false; o.rechazadaPor=por.nombre; });
      campos={estado:"sin_exito",ofertas:ofs,pendienteDe:null,
        resolucion:{tipo:"rechazada",por:por.nombre,rol:por.nivel,fecha:hoyS,nota:nota||""}};
    } else {
      const need=RC.nivelNecesario(e);
      const dest=need==="ceo"||por.nivel!=="jefe"?(cad.ceo||cad.dir):(cad.dir||cad.ceo);
      campos={estado:"pendiente_aprobacion",escaladoA:dest&&dest.id,pendienteDe:dest&&dest.id,pendienteDeNombre:dest&&dest.nombre};
    }
    campos.historialEscalado=(e.historialEscalado||[]).concat([{accion:accion==="aprobar"?"✅ Aprobada por "+por.nombre
      :accion==="rechazar"?"❌ Rechazada por "+por.nombre:"↑ Elevada a "+(campos.pendienteDeNombre||"dirección"),por:por.nombre,fecha:hoyS,nota:nota||""}]);
    await RC.guardarEn("estrategias",e._id||e.id,campos,true);
    Object.assign(e,campos);
    // Oferta automática al aprobar, como hace el CRM
    if(accion==="aprobar") await RC.ofertaDeEstrategia(e,por,nota);
    try{
      const txt=accion==="aprobar"?"✅ Aprobada":accion==="rechazar"?"❌ Rechazada":"↑ Elevada";
      if(accion==="elevar"&&campos.pendienteDe) await RC.avisarA(campos.pendienteDe,`↑ ${por.nombre} te eleva una estrategia: ${e.cliente}`,
        `${RC.esc(e.estrategia||e.texto||"")}. Descuento ${num(e.maxDescuento)} %.${nota?"<br><i>“"+RC.esc(nota)+"”</i>":""}`);
      else {
        const cuerpo=`${RC.esc(e.estrategia||"")} · descuento ${num(e.maxDescuento)} %. Lo ha decidido <b>${RC.esc(por.nombre)}</b>.${nota?"<br><i>“"+RC.esc(nota)+"”</i>":""}`
          +(accion==="aprobar"?"<br>Tiene la oferta creada en el CRM. <b>La semana que viene, en el parte, dirá si ha entrado pedido.</b>":"");
        await RC.avisarA(e.agente,`${txt}: tu estrategia para ${e.cliente}`,cuerpo);
        // Copia al jefe de equipo si no ha sido él quien la ha decidido
        if(cad.resp&&ARR(cad.resp.id)!==ARR(por.id)) await RC.avisarA(cad.resp.id,`${txt}: estrategia de ${cad.ag.nombre} para ${e.cliente}`,cuerpo);
      }
    }catch(x){}
    return e;
  };
  RC.estrategiasDeCaso=(ests,c)=>ests.filter(e=>!e.eliminada&&(e.casoId===c._id||ARR(e.clienteId)===ARR(c.cliente)));
  RC.ESTADO_EST={pendiente_aprobacion:["⏳ Pendiente","#B45309","#FFFBEB"],aprobada:["✅ Aprobada","#15803D","#F0FDF4"],
    sin_exito:["✖ Rechazada","#B91C1C","#FEF2F2"],completada:["✅ Pedido","#15803D","#F0FDF4"],pendiente:["⏳ Pendiente","#B45309","#FFFBEB"]};
  // ¿Puede este nivel resolverla? (límite de descuento y a quién está pendiente)
  RC.puedeResolverEst=(e,nivel,miId)=>{
    if(e.estado!=="pendiente_aprobacion") return false;
    if(nivel==="ceo") return true;
    if(nivel==="director") return RC.dtoEf(e)<=RC.LIM_DTO.director;
    if(nivel==="jefe") return RC.dtoEf(e)<=RC.LIM_DTO.jefe;
    return false;
  };
  // ── Descuento que cuenta para aprobar: el EXTRA sobre la tarifa del cliente
  // Las estrategias del CRM guardan el descuento total sobre catálogo; aquí se
  // pasa a descuento sobre su tarifa (hay que llamar antes a prepararEsts).
  RC.dtoEf=(e)=>e._dtoEf!=null?e._dtoEf:num(e.maxDescuento);
  RC.prepararEsts=async(lista)=>{
    const pend=(lista||[]).filter(e=>e.estado==="pendiente_aprobacion"||e.estado==="aprobada");
    await Promise.all(pend.map(async e=>{
      const o=(e.ofertas||[])[0]||{}, fin=num(o.precioFinal||o.precioOferta);
      if(num(o.precioActual)>0||!(num(o.precioBase)>0)||!(fin>0)) return;
      try{ const t=await RC.tarifaCliente(e.clienteId||e.clienteCodigo,e.cliente||e.clienteNombre);
        const tar=num(o.precioBase)*(1-t.dto/100);
        e._dtoCli=t.dto; e._catCli=t.cat; e._sinTarifa=!!t.sinDato; e._tarifaCli=Math.round(tar*100)/100;
        e._dtoEf=tar>0?Math.max(0,Math.round((1-fin/tar)*1000)/10):num(e.maxDescuento); }catch(x){}
    }));
    return lista;
  };
  const RANGO={jefe:1,director:2,ceo:3};
  RC.nivelNecesario=(e)=>{ const d=RC.dtoEf(e); return d>RC.LIM_DTO.director?"ceo":d>RC.LIM_DTO.jefe?"director":"jefe"; };
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
        precio:num(l.precioOferta),precioBase:num(l.precioBase)||num(l.precioActual)||"",
        dto:num(l.precioBase)>0?RC.dtoDe(l.precioBase,l.precioOferta):(num(l.precioActual)>0?dto:""),
        precioTarifaCliente:num(l.precioActual)||"",dtoTarifaCliente:l.dtoCliente!=null?l.dtoCliente:"",dtoExtra:num(l.precioActual)>0?dto:"",
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
  // ── Alternativa: otro producto del catálogo en lugar del que ha dejado ──
  RC.formAlternativa=(pref,a,caso)=>RC.formEstrategia(pref,[],`🔄 Ofrecer alternativa${a?` a ${RC.esc(a.desc||a.art)}${a.art?" ("+RC.esc(a.art)+")":""}`:""}`,
      {fondo:"#FFF7ED",borde:"#FED7AA",fuerte:"#EA580C",titulo:"#C2410C"},caso)
    .replace("Por qué (qué le ofrece la competencia, volumen, plazo…)","Por qué le encaja (mismo rendimiento, más barato, disponible ya…)");
  RC.leerAlternativa=(pref)=>{ const l=RC.leerFormEstrategia(pref,[]);
    return {art:l.art,desc:l.desc,cal:l.cal,deCatalogo:l.deCatalogo,precioActual:l.precioActual,precioBase:l.precioBase,dtoCliente:l.dtoCliente,catCliente:l.catCliente,precio:l.precioOferta,precioOferta:l.precioOferta,unidad:l.unidad,nota:l.nota}; };
  // Se registra como oferta del CRM, marcada como alternativa del artículo perdido
  RC.crearAlternativa=async(caso,orig,alt,por)=>{
    // Mismo proceso que cualquier oferta: descuento contra la tarifa del
    // catálogo y límite de quien la hace. Si se pasa, va como estrategia.
    const lim=await RC.limitesDto();
    const tope=por.nivel==="ceo"?100:por.nivel==="director"?lim.director:por.nivel==="jefe"?lim.jefe:lim.agente;
    const dto=RC.dtoDe(alt.precioActual,alt.precio);
    const txtO=(orig.desc||orig.art||"")+(orig.art&&orig.desc?" ("+orig.art+")":"");
    if(num(alt.precioActual)>0&&dto>tope){
      const e=await RC.crearEstrategia(caso,{art:alt.art,desc:alt.desc,cal:alt.cal,precioActual:alt.precioActual,precioBase:alt.precioBase,dtoCliente:alt.dtoCliente,precioOferta:alt.precio,unidad:alt.unidad},
        "Alternativa a "+txtO+(alt.nota?" · "+alt.nota:"")+" · "+dto+" % sobre tarifa, supera el límite del "+tope+" %",por);
      e.alternativaDe={codigo:orig.art||"",nombre:orig.desc||""};
      try{ await RC.guardarEn("estrategias",e.id,{alternativaDe:e.alternativaDe},true); }catch(x){}
      e._esEstrategia=true; e.dto=dto; e.tope=tope;
      return e;
    }
    const cad=await RC.cadenaDe(caso.agente);
    const hoy=new Date(), hoyS=hoy.toLocaleDateString("es-ES",{day:"2-digit",month:"2-digit",year:"2-digit"});
    const plazo=new Date(hoy.getTime()+5*86400000);
    const id="oferta_alt_"+Date.now()+"_"+Math.random().toString(36).slice(2,5);
    const txtOrig=(orig.desc||orig.art||"")+(orig.art&&orig.desc?" ("+orig.art+")":"");
    const doc={id,clienteNombre:caso.nombre,clienteCodigo:caso.cliente,clienteId:caso.cliente,
      agente:cad.ag.id,agenteNombre:cad.ag.nombre,equipo:cad.ag.equipo||caso.equipo||"",
      lineas:[{id:"l1",producto:alt.desc,descripcion:alt.desc,codigo:alt.art||"",calibre:alt.cal||"",precio:num(alt.precio),
        precioBase:num(alt.precioBase)||num(alt.precioActual)||"",
        dto:num(alt.precioBase)>0?RC.dtoDe(alt.precioBase,alt.precio):(num(alt.precioActual)>0?dto:""),
        precioTarifaCliente:num(alt.precioActual)||"",dtoTarifaCliente:alt.dtoCliente!=null?alt.dtoCliente:"",dtoExtra:num(alt.precioActual)>0?dto:"",
        unidad:"€/"+(alt.unidad||"m"),cantidad:0,notas:"Alternativa a "+txtOrig+(alt.nota?" · "+alt.nota:"")}],
      alternativaDe:{codigo:orig.art||"",nombre:orig.desc||""},
      estado:"pendiente",fechaCreacion:hoy.toISOString(),fechaCreacionStr:hoyS,fechaPlazo:plazo.toISOString(),
      notaInicial:"Alternativa desde el plan de recuperación",notas:"Alternativa a "+txtOrig+(alt.nota?" · "+alt.nota:""),
      origen:"recuperacion",casoId:caso._id||"",
      seguimientos:[{accion:"🔄 Alternativa ofrecida en lugar de "+txtOrig,fecha:hoyS,por:por.nombre,nota:alt.nota||""}]};
    await RC.guardarEn("ofertas",id,doc);
    if(caso._id){
      const hist=(caso.historial||[]).concat([{sem:RC.semanaISO(hoy),fecha:hoy.toISOString(),por:por.nombre,
        sistema:`Alternativa: ${alt.desc}${alt.cal?" "+alt.cal:""} a ${num(alt.precio)} €/${alt.unidad||"m"} en lugar de ${txtOrig}`}]);
      const campos={historial:hist}; if(por.nivel==="comercial") campos.ultimaAccion=hoy.toISOString();
      try{ await RC.guardar(caso._id,campos); Object.assign(caso,campos); }catch(e){}
    }
    // Si la propone el jefe, el comercial se entera en el momento
    if(por.nivel!=="comercial"){
      try{ await RC.avisarGenerico({agente:caso.agente,quienId:por.id,quien:por.nombre,titulo:caso.nombre,etiqueta:"Alternativa para el cliente",
        texto:`Ofrécele ${alt.desc}${alt.cal?" "+alt.cal:""} a ${num(alt.precio)} €/${alt.unidad||"m"} en lugar de ${txtOrig}.${alt.nota?" "+alt.nota:""}`,
        pie:"La tienes como oferta en el CRM → Ofertas."}); }catch(e){}
    }
    return doc;
  };
  RC.htmlOferta=(o)=>{
    const l=(o.lineas||[])[0]||{};
    return `<div style="border:1px solid #BFDBFE;background:#EFF6FF;border-radius:12px;padding:10px 12px;margin:8px 0">
      <b style="font-size:13.5px">${o.alternativaDe?"🔄 Alternativa":"📨 Oferta"}: ${RC.esc(l.producto||"")}${l.calibre?" · "+RC.esc(l.calibre):""}</b>
      ${o.alternativaDe?`<div style="font-size:12px;color:#C2410C">en lugar de ${RC.esc(o.alternativaDe.nombre||"")} ${o.alternativaDe.codigo?"("+RC.esc(o.alternativaDe.codigo)+")":""}</div>`:""}
      <div style="font-size:13px;margin-top:3px">${l.precioBase?RC.esc(l.precioBase)+" € → ":""}<b style="color:#1D4ED8">${RC.esc(l.precio)} ${RC.esc(l.unidad||"")}</b>${l.dto!==""&&l.dto!=null?" · descuento "+RC.esc(l.dto)+" %":""}</div>
      <div style="font-size:12px;color:#475569;margin-top:2px">Registrada en el CRM → Ofertas · seguimiento en 5 días</div></div>`;
  };

  // ¿Le toca verla y decidir (aprobar si puede, si no elevar o rechazar)?
  // (sep 2026) Solo le toca a quien la tiene: al que figura en «pendienteDe»
  // (o «escaladoA»). Si no figura nadie, por el descuento: jefe hasta su
  // límite, jefe de ventas hasta el suyo, CEO por encima.
  RC._forzar=new Set();   // «Decidir yo»: el CEO/jefe de ventas se la queda
  RC.rolDeId=(id)=>{
    const k=ARR(id); if(!k) return "";
    if(k==="CEO") return "ceo";
    const u=(RC._us||[]).find(x=>[x._id,x.id,x.username,x.grupoAgente,x.crmId].some(v=>v&&ARR(v)===k));
    if(!u) return "";
    const r=String(u.rol||"").toLowerCase();
    if(r==="ceo"||r==="admin"||[u._id,u.id,u.username].some(v=>ARR(v)==="CEO")) return "ceo";
    if(r==="director"||r==="crm_director") return "director";
    if(r==="jefe"||r==="crm_jefe") return "jefe";
    return "otro";
  };
  RC.mismoUsuario=(a,b)=>{
    if(ARR(a)===ARR(b)) return true;
    const u=(RC._us||[]).find(x=>[x._id,x.id,x.username,x.grupoAgente,x.crmId].some(v=>v&&ARR(v)===ARR(a)));
    return !!u&&[u._id,u.id,u.username,u.grupoAgente,u.crmId,u.catalogoVendedor].some(v=>v&&ARR(v)===ARR(b));
  };
  // Quién la tiene de verdad: si está con alguien que no llega a su
  // descuento (p. ej. con un jefe de equipo y pide un 20 %), pasa al nivel
  // que sí puede aprobarla.
  RC.quienLaTiene=(e)=>{
    const need=RC.nivelNecesario(e), dest=e.pendienteDe||e.escaladoA||"";
    const r=dest?RC.rolDeId(dest):"";
    if(dest&&(r==="otro"||(r&&RANGO[r]>=RANGO[need]))) return {id:dest,nombre:e.pendienteDeNombre||dest,rol:r,ok:true};
    if(dest&&!r&&need==="jefe") return {id:dest,nombre:e.pendienteDeNombre||dest,rol:"",ok:true};
    return {id:"",nombre:need==="ceo"?"CEO":need==="director"?"Jefe de ventas":"Jefe de equipo",rol:need,ok:!dest,
      antes:dest?(e.pendienteDeNombre||dest):""};
  };
  RC.meTocaEst=(e,nivel,miId)=>{
    if(e.estado!=="pendiente_aprobacion") return false;
    if(RC._forzar.has(e._id||e.id)&&(nivel==="ceo"||nivel==="director")) return true;
    const q=RC.quienLaTiene(e);
    if(q.id) return !!miId&&RC.mismoUsuario(q.id,miId)||(q.rol===nivel&&q.rol!=="jefe"&&q.rol!=="otro");
    return q.rol===nivel;
  };
  RC.decidirYo=(id)=>{ RC._forzar.add(id); if(typeof window.pintar==="function") window.pintar(); };
  // Pendientes de mi ámbito que tiene otra persona (para verlas sin decidir)
  RC.htmlDeOtros=(lista,nivel)=>{
    const forzar=nivel==="ceo"||nivel==="director";
    if(!lista.length) return "";
    const porQuien={}; lista.forEach(e=>{ const q=RC.quienLaTiene(e).nombre; (porQuien[q]=porQuien[q]||[]).push(e); });
    return `<details style="margin-top:10px"><summary style="cursor:pointer;font-weight:800;font-size:13.5px;color:#475569">👀 ${forzar?"Las tienen otros":"De tu equipo, en manos de otros"} (${lista.length}) · no te toca decidirlas</summary>
      ${Object.entries(porQuien).sort((a,b)=>b[1].length-a[1].length).map(([q,l])=>`<div style="margin-top:8px"><b style="font-size:13px">${RC.esc(q)} · ${l.length}</b>
        ${l.sort((a,b)=>RC.fechaEst(a)-RC.fechaEst(b)).map(e=>`<div style="opacity:.9">${RC.htmlEstrategia(e,forzar?`<button type="button" onclick="RC.decidirYo('${e._id||e.id}')" style="margin-top:6px;padding:7px 12px;border-radius:9px;border:1.5px solid #CBD5E1;background:#fff;font-weight:700;font-size:12.5px;cursor:pointer">⚡ Decidir yo</button>`:"")}<div style="font-size:11.5px;color:#6B7280;margin:-4px 0 6px">${RC.esc(e.cliente||"")} · ${RC.esc(e.agenteNombre||e.agente||"")}</div></div>`).join("")}</div>`).join("")}</details>`;
  };
  // ══ Catálogo (colección «productos», la misma del CRM) ═══════════════
  // El precio del catálogo es la tarifa base: el descuento se calcula contra
  // él, igual que en el formulario de ofertas del CRM.
  RC.catalogo=async()=>{
    if(RC._cat) return RC._cat;
    if(!RC._catProm) RC._catProm=(async()=>{
      const out=[]; let tok=null,v=0;
      do{ const r=await fetch(`${RC.FB}/productos?pageSize=300`+(tok?`&pageToken=${encodeURIComponent(tok)}`:""));
        if(!r.ok) break; const j=await r.json();
        for(const d of j.documents||[]){ const f=d.fields||{}; const g=(k)=>f[k]?(f[k].stringValue??f[k].doubleValue??f[k].integerValue??""):"";
          out.push({codigo:String(g("codigo")),nombre:String(g("nombre")),formato:String(g("formato")),
            calibre:String(g("calibre")||g("ca")),metros:String(g("medida")||g("metros")||g("me")),
            precio:Number(String(g("precio")).replace(",","."))||0,cat:String(g("categoria")||g("cat"))}); }
        tok=j.nextPageToken||null; v++; }while(tok&&v<60);
      RC._cat=out; return out; })();
    return RC._catProm;
  };
  // ══ Tarifa del cliente (colección «clientes», como el CRM) ═══════════
  // Precio de tarifa del cliente = precio base del catálogo − su descuento de
  // tarifa (el asignado; si no tiene, el estándar de su categoría). Los
  // descuentos de oferta/estrategia se miden contra ESE precio.
  RC.DTO_CAT={"Carnicero":0,"Fabricante":10,"Distribuidor":18,"Gran cuenta":25};
  RC._tc={};
  RC.tarifaCliente=async(cod,nombre)=>{
    const k=ARR(cod)||ARR(nombre); if(!k) return {dto:0,cat:"",hay:false};
    if(RC._tc[k]) return RC._tc[k];
    RC._tc[k]=(async()=>{
      const out=(f)=>{ const g=(x)=>f[x]?(f[x].stringValue??f[x].doubleValue??f[x].integerValue??null):null;
        const cat=String(g("categoriaCliente")||""); let d=g("dtoTarifa");
        d=(d!=null&&d!==""&&!isNaN(parseFloat(d)))?parseFloat(d):(RC.DTO_CAT[cat]!=null?RC.DTO_CAT[cat]:null);
        return {dto:d==null?0:d,cat,hay:d!=null,sinDato:d==null}; };
      try{ if(cod){ const r=await fetch(`${RC.FB}/clientes/${encodeURIComponent(cod)}`); if(r.ok){ const j=await r.json(); if(j.fields) return out(j.fields); } } }catch(e){}
      const base=RC.FB.replace(/\/documents$/,"")+"/documents:runQuery";
      const q=async(campo,v)=>{ try{ const r=await fetch(base,{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({structuredQuery:{from:[{collectionId:"clientes"}],where:{fieldFilter:{field:{fieldPath:campo},op:"EQUAL",value:{stringValue:v}}},limit:1}})});
        if(!r.ok) return null; const j=await r.json(); const d=(j||[]).find(x=>x.document); return d?d.document.fields:null; }catch(e){ return null; } };
      let f=null;
      if(cod) f=await q("codigo",String(cod))||await q("CODIGO",String(cod));
      if(!f&&nombre) f=await q("nombre",String(nombre));
      return f?out(f):{dto:0,cat:"",hay:false,sinDato:true};
    })();
    return RC._tc[k];
  };
  RC._cliPref={};
  RC._sel={}; RC._res={};
  const txtCat=(p)=>[p.codigo,p.nombre,p.calibre?"cal. "+p.calibre:"",p.metros?p.metros+" m":"",p.formato].filter(Boolean).join(" · ");
  RC.buscarUI=async(pref)=>{
    const q=ARR((document.getElementById(pref+"_q")||{}).value||"");
    const box=document.getElementById(pref+"_res"); if(!box) return;
    if(q.length<2){ box.innerHTML=""; return; }
    box.innerHTML=`<div style="font-size:12px;color:#6B7280;padding:4px">Buscando…</div>`;
    const cat=await RC.catalogo();
    const tk=q.split(/\s+/).filter(Boolean);
    const r=cat.filter(p=>{ const h=ARR([p.codigo,p.nombre,p.calibre,p.formato,p.metros].join(" ")); return tk.every(t=>h.includes(t)); }).slice(0,8);
    RC._res[pref]=r;
    box.innerHTML=r.length?r.map((p,i)=>`<div onclick="RC.elegirCat('${pref}',${i})" style="padding:8px 10px;border-bottom:1px solid #EEF2F7;cursor:pointer;font-size:13px;background:#fff">
        <b>${RC.esc(p.codigo)}</b> · ${RC.esc(p.nombre)}${p.calibre?" · cal. "+RC.esc(p.calibre):""}${p.metros?" · "+RC.esc(p.metros)+" m":""}
        <span style="float:right;font-weight:700">${p.precio?RC.esc(p.precio.toFixed(2))+" €":"sin precio"}</span></div>`).join("")
      :`<div style="font-size:12.5px;color:#B45309;padding:6px">No hay nada en el catálogo con «${RC.esc(q)}».</div>`;
  };
  const r2=(n)=>Math.round(n*100)/100, f2=(n)=>num(n).toFixed(2).replace(".",",");
  const pintaSel=async(pref)=>{
    const p=RC._sel[pref], el=document.getElementById(pref+"_sel"), pa=document.getElementById(pref+"_pa");
    const q=document.getElementById(pref+"_q"); if(q&&p) q.value="";
    const r=document.getElementById(pref+"_res"); if(r) r.innerHTML="";
    if(!p){ if(el) el.innerHTML=""; if(pa){ pa.readOnly=false; pa.style.background="#fff"; } return; }
    if(p.precio&&p.dtoCli==null){
      if(el) el.innerHTML=`<div style="font-size:12.5px;color:#6B7280;padding:6px">Buscando la tarifa del cliente…</div>`;
      const cli=RC._cliPref[pref]||{};
      const t=await RC.tarifaCliente(cli.cliente,cli.nombre);
      if(RC._sel[pref]!==p) return;       // ha cambiado mientras tanto
      p.dtoCli=t.dto; p.catCli=t.cat; p.sinTarifa=!!t.sinDato;
      p.tarifaCli=r2(p.precio*(1-t.dto/100));
    }
    const elx=document.getElementById(pref+"_sel"), pax=document.getElementById(pref+"_pa");
    if(elx) elx.innerHTML=`<div style="background:#fff;border:1.5px solid #16A34A;border-radius:9px;padding:8px 10px;font-size:13px">✔ <b>${RC.esc(txtCat(p))}</b>
      ${p.precio?`<div style="font-size:12.5px;color:#374151;margin-top:3px">Catálogo ${f2(p.precio)} € − ${p.dtoCli} % ${p.catCli?"("+RC.esc(p.catCli)+")":"de su tarifa"} = <b>tarifa del cliente ${f2(p.tarifaCli)} €</b></div>
        ${p.sinTarifa?`<div style="font-size:12px;color:#B45309">Este cliente no tiene tarifa ni categoría en el CRM: se toma el precio de catálogo.</div>`:""}`
      :`<div style="font-size:12.5px;color:#B45309;margin-top:3px">No tiene precio en el catálogo: pon a mano el precio de tarifa del cliente.</div>`}</div>`;
    if(pax&&p.precio){ pax.value=p.tarifaCli.toFixed(2); pax.readOnly=true; pax.style.background="#F1F5F9"; }
    else if(pax){ pax.readOnly=false; pax.style.background="#fff"; }
    RC.dtoUI(pref);
  };
  RC.elegirCat=(pref,i)=>{ const p=(RC._res[pref]||[])[i]; if(!p) return; RC._sel[pref]=Object.assign({deCatalogo:true},p); pintaSel(pref); };
  RC.elegirPorCodigo=async(pref,cod,nombre)=>{
    const cat=await RC.catalogo();
    const p=cod?cat.find(x=>ARR(x.codigo)===ARR(cod)):null;
    RC._sel[pref]=p?Object.assign({deCatalogo:true},p):{codigo:cod||"",nombre:nombre||cod||"",calibre:"",metros:"",precio:0,deCatalogo:false};
    pintaSel(pref);
  };
  // Tras pintar un formulario: deja elegido el artículo de la fila (si lo hay)
  RC.prepararForm=(pref,a)=>{ RC._sel[pref]=null; if(a&&(a.art||a.desc)) RC.elegirPorCodigo(pref,a.art,a.desc); else RC.catalogo(); };
  // Llamar después de pintar: activa los formularios nuevos (deja elegido el
  // artículo de la fila) y, si la pantalla se ha repintado, recupera lo elegido.
  RC._key={};
  RC.activarForms=()=>{
    document.querySelectorAll("[data-rcpref]").forEach(el=>{
      const pref=el.getAttribute("data-rcpref"), key=el.getAttribute("data-rckey")||"";
      RC._cliPref[pref]={cliente:el.getAttribute("data-rccli")||"",nombre:el.getAttribute("data-rcnom")||""};
      if(RC._key[pref]!==key){ RC._key[pref]=key;
        RC.prepararForm(pref,{art:el.getAttribute("data-rcart")||"",desc:el.getAttribute("data-rcdesc")||""}); }
      else if(RC._sel[pref]) pintaSel(pref);
    });
  };
  RC.olvidarForm=(pref)=>{ delete RC._key[pref]; RC._sel[pref]=null; };
  RC.htmlBuscador=(pref,sugeridos,titulo)=>`
      <div style="font-size:12px;color:#6B7280">${titulo||"Artículo del catálogo"}</div>
      <input id="${pref}_q" oninput="RC.buscarUI('${pref}')" autocomplete="off" placeholder="🔍 Busca: código, nombre o calibre" style="padding:9px;border:1.5px solid #CBD5E1;border-radius:9px;font:inherit;font-size:14px">
      <div id="${pref}_res" style="border-radius:9px;overflow:hidden;box-shadow:0 1px 0 #E5E7EB;max-height:260px;overflow-y:auto"></div>
      ${(sugeridos||[]).length?`<div style="display:flex;gap:5px;flex-wrap:wrap">${sugeridos.slice(0,6).map(a=>`<button type="button" onclick="RC.elegirPorCodigo('${pref}','${RC.esc(a.art).replace(/'/g,"")}','${RC.esc(a.desc).replace(/'/g,"")}')" style="border:1px solid #CBD5E1;background:#fff;border-radius:99px;padding:5px 10px;font-size:12px;cursor:pointer">${RC.esc(a.art||a.desc)}</button>`).join("")}</div>`:""}
      <div id="${pref}_sel"></div>`;
  // Formulario de estrategia u oferta: artículo del catálogo, tarifa, precio
  const attr=(t)=>RC.esc(t).replace(/"/g,"&quot;");
  RC.formEstrategia=(pref,arts,texto,colores,caso)=>{
    const c=Object.assign({fondo:"#F5F3FF",borde:"#DDD6FE",fuerte:"#7C3AED",titulo:"#5B21B6"},colores||{});
    const uno=(arts||[]).length===1, a0=uno?arts[0]:{};
    const cl=caso||{};
    const key=(texto||"")+"|"+(a0.art||"")+"|"+(a0.desc||"")+"|"+(cl.cliente||cl.nombre||"");
    return `<div data-rcpref="${pref}" data-rckey="${attr(key)}" data-rcart="${attr(a0.art)}" data-rcdesc="${attr(a0.desc)}" data-rccli="${attr(cl.cliente)}" data-rcnom="${attr(cl.nombre)}" style="display:grid;gap:7px;background:${c.fondo};border:1px solid ${c.borde};border-radius:12px;padding:12px;margin-top:8px">
      <div style="font-weight:800;color:${c.titulo}">${texto||"💶 Estrategia de precio"}</div>
      ${RC.htmlBuscador(pref,uno?[]:arts,uno?"Artículo (puedes cambiarlo buscando en el catálogo)":"Artículo del catálogo · o toca uno de los que ha dejado")}
      ${RC.htmlPrecios(pref,c.borde,c.fuerte)}
      <div id="${pref}_dto" style="font-size:12.5px;font-weight:700"></div>
      <textarea id="${pref}_nota" placeholder="Por qué (qué le ofrece la competencia, volumen, plazo…)" style="min-height:52px;padding:9px;border:1.5px solid ${c.borde};border-radius:9px;font:inherit;font-size:14px"></textarea>
    </div>`;
  };
  // Muestra el descuento al teclear y si entra en el límite de quien lo hace
  RC.NIVEL_UI="comercial";
  // Tarifa · Descuento % · Precio: se rellena uno u otro y se calcula el otro
  RC.htmlPrecios=(pref,borde,fuerte,tarifa)=>`<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
        <label style="font-size:12px;color:#6B7280">Tarifa cliente €<input id="${pref}_pa" type="number" step="0.01" value="${tarifa||""}" oninput="RC.dtoUI('${pref}','pa')" style="width:100%;padding:9px;border:1.5px solid ${borde};border-radius:9px;font-size:14px"></label>
        <label style="font-size:12px;color:#6B7280">Descuento %<input id="${pref}_pd" type="number" step="0.1" oninput="RC.dtoUI('${pref}','pd')" style="width:100%;padding:9px;border:1.5px solid ${fuerte};border-radius:9px;font-size:14px;font-weight:700"></label>
        <label style="font-size:12px;color:#6B7280">Precio nuevo €<input id="${pref}_po" type="number" step="0.01" oninput="RC.dtoUI('${pref}','po')" style="width:100%;padding:9px;border:1.5px solid ${fuerte};border-radius:9px;font-size:14px;font-weight:700"></label>
      </div><input type="hidden" id="${pref}_ud" value="m">`;
  RC.dtoUI=async(pref,origen)=>{
    const g=(k)=>document.getElementById(pref+"_"+k);
    const nv=(k)=>Number(((g(k)||{}).value||"").replace(",","."));
    // Si se escribe el descuento, se calcula el precio; si se escribe el precio, el descuento
    if(origen==="pd"||(origen==="pa"&&nv("pd")>0&&!(nv("po")>0))){ const pa0=nv("pa"), d0=nv("pd");
      if(pa0>0&&(g("pd").value!=="")&&g("po")) g("po").value=(Math.round(pa0*(1-d0/100)*100)/100).toFixed(2); }
    else if((origen==="po"||origen==="pa"||!origen)&&g("pd")){ const pa0=nv("pa"), po0=nv("po");
      if(pa0>0&&po0>0) g("pd").value=String(Math.round((1-po0/pa0)*1000)/10); else if(origen==="po") g("pd").value=""; }
    const pa=nv("pa"), po=nv("po");
    const el=g("dto"); if(!el) return;
    if(!(pa>0&&po>0)){ el.innerHTML=""; return; }
    const lim=await RC.limitesDto(); const n=RC.NIVEL_UI;
    const tope=n==="ceo"?100:n==="director"?lim.director:n==="jefe"?lim.jefe:lim.agente;
    const d=Math.round((1-po/pa)*1000)/10;
    el.innerHTML=d<=0?`<span style="color:#15803D">Sin descuento sobre tarifa</span>`
      :d<=tope?`<span style="color:#15803D">Descuento ${d} %: dentro de tu límite (${tope} %)</span>`
      :`<span style="color:#B45309">Descuento ${d} %: supera tu límite del ${tope} % → irá a aprobación</span>`;
  };
  RC.leerFormEstrategia=(pref,arts)=>{
    const v=(k)=>{ const el=document.getElementById(pref+"_"+k); return el?String(el.value||"").trim():""; };
    let p=RC._sel[pref];
    if(!p&&(arts||[]).length===1) p={codigo:arts[0].art,nombre:arts[0].desc,calibre:arts[0].cal||""};
    p=p||{};
    return {art:p.codigo||"",desc:p.nombre||"",cal:p.calibre||"",metros:p.metros||"",deCatalogo:!!p.deCatalogo,
      precioBase:num(p.precio)||0,dtoCliente:p.dtoCli!=null?p.dtoCli:null,catCliente:p.catCli||"",
      precioActual:Number(v("pa").replace(",","."))||0,precioOferta:Number(v("po").replace(",","."))||0,unidad:v("ud")||"m",nota:v("nota")};
  };
  // ══ Al decidir: proponer OTRO PRECIO o una ALTERNATIVA ═══════════════
  RC._extraEst=null;   // {id, tipo:"precio"|"alt"}
  RC.topeDe=async(nivel)=>{ const lim=await RC.limitesDto();
    return nivel==="ceo"?100:nivel==="director"?lim.director:nivel==="jefe"?lim.jefe:lim.agente; };
  // Precio de referencia (tarifa del cliente) de la línea de una estrategia
  RC.refEst=async(e)=>{
    const o=(e.ofertas||[])[0]||{};
    if(num(o.precioActual)>0) return num(o.precioActual);
    if(num(o.precioBase)>0){ const t=await RC.tarifaCliente(e.clienteId||e.clienteCodigo,e.cliente||e.clienteNombre);
      return Math.round(num(o.precioBase)*(1-t.dto/100)*100)/100; }
    return 0;
  };
  RC.abrirExtraEst=(id,tipo)=>{ RC._extraEst=(RC._extraEst&&RC._extraEst.id===id&&RC._extraEst.tipo===tipo)?null:{id,tipo};
    if(typeof window.pintar==="function") window.pintar(); };
  RC.htmlExtrasEst=(e)=>{
    const id=e._id||e.id, ab=RC._extraEst&&RC._extraEst.id===id?RC._extraEst.tipo:null;
    const o=(e.ofertas||[])[0]||{}, pref="xe"+String(id).replace(/[^A-Za-z0-9_]/g,"");
    const b=(t,txt,col)=>`<button type="button" onclick="RC.abrirExtraEst('${id}','${t}')" style="padding:9px;border-radius:10px;border:1.5px solid ${col};background:${ab===t?col:"#fff"};color:${ab===t?"#fff":col};font-weight:700;font-size:13px;cursor:pointer">${txt}</button>`;
    let h=`<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px">${b("precio","💬 Proponer otro precio","#2563EB")}${b("alt","🔄 Proponer alternativa","#EA580C")}</div>`;
    if(ab==="precio"){
      const ref=num(o.precioActual)||"";
      h+=`<div style="display:grid;gap:6px;background:#EFF6FF;border:1px solid #BFDBFE;border-radius:12px;padding:10px;margin-top:6px">
        <div style="font-weight:800;color:#1D4ED8">💬 Otro precio para ${RC.esc(o.nombre||"el artículo")}</div>
        <div style="font-size:12.5px;color:#374151">Pide <b>${RC.esc(o.precioFinal||o.precioOferta||"")} €/${RC.esc(o.unidad||"m")}</b>. Pon el precio que sí le das.</div>
        ${RC.htmlPrecios(pref,"#BFDBFE","#2563EB",ref).replace(`oninput="RC.dtoUI('${pref}','pa')"`,"readonly").replace('border:1.5px solid #BFDBFE;border-radius:9px;font-size:14px">','border:1.5px solid #BFDBFE;border-radius:9px;font-size:14px;background:#F1F5F9">')}
        <div id="${pref}_dto" style="font-size:12.5px;font-weight:700"></div>
        <button type="button" onclick="extraEstEnviar('${id}','precio')" style="padding:11px;border-radius:10px;border:none;background:#2563EB;color:#fff;font-weight:800;font-size:14px;cursor:pointer">Enviar este precio</button>
        <div style="font-size:12px;color:#6B7280">Si entra en tu límite queda aprobada a ese precio; si no, sube a tu superior con el precio nuevo. Al comercial le llega el aviso.</div></div>`;
      if(!ref) setTimeout(async()=>{ const r=await RC.refEst(e); const el=document.getElementById(pref+"_pa"); if(el&&r){ el.value=r.toFixed(2); RC.dtoUI(pref); } },0);
    }
    if(ab==="alt"){
      h+=RC.formAlternativa(pref,{art:o.codigo||"",desc:o.nombre||""},{cliente:e.clienteId||e.clienteCodigo||"",nombre:e.cliente||e.clienteNombre||""})
        +`<button type="button" onclick="extraEstEnviar('${id}','alt')" style="width:100%;margin-top:6px;padding:11px;border-radius:10px;border:none;background:#EA580C;color:#fff;font-weight:800;font-size:14px;cursor:pointer">Proponer esta alternativa</button>
        <div style="font-size:12px;color:#6B7280;margin-top:4px">La estrategia se cierra como «cambiada por alternativa» y al comercial le llega la oferta nueva (o va a aprobación si pasa tu límite).</div>`;
    }
    return h;
  };
  RC.prefExtra=(id)=>"xe"+String(id).replace(/[^A-Za-z0-9_]/g,"");
  // Otro precio: aprueba (o eleva) la estrategia con el precio nuevo
  RC.contraofertaEst=async(e,precio,por,nota)=>{
    const ofs=(e.ofertas||[]).map(o=>Object.assign({},o)); const o=ofs[0]||{};
    const ref=await RC.refEst(e), antes=num(o.precioFinal||o.precioOferta);
    const dto=ref>0?RC.dtoDe(ref,precio):num(e.maxDescuento);
    Object.assign(o,{precioSolicitado:antes,precioFinal:num(precio),precioAprobado:num(precio),precioActual:o.precioActual||ref||"",dto});
    const hoyS=new Date().toLocaleDateString("es-ES");
    const campos={ofertas:ofs,productos:ofs,maxDescuento:dto,contraoferta:{precio:num(precio),antes,por:por.nombre,rol:por.nivel,fecha:hoyS,nota:nota||""}};
    await RC.guardarEn("estrategias",e._id||e.id,campos,true); Object.assign(e,campos);
    const tope=await RC.topeDe(por.nivel);
    const txt=`Contraoferta: ${num(precio)} € en vez de ${antes} € (${dto} % sobre su tarifa)`+(nota?". "+nota:"");
    return RC.resolverEstrategia(e,dto<=tope?"aprobar":"elevar",por,txt);
  };
  // Alternativa: cierra la estrategia y crea la oferta (o estrategia) del otro artículo
  RC.alternativaEst=async(e,alt,por,nota)=>{
    let caso=null; if(e.casoId){ try{ caso=await RC.leerUno(e.casoId); }catch(x){} }
    caso=caso||{_id:"",nombre:e.cliente||e.clienteNombre||"",cliente:e.clienteId||e.clienteCodigo||"",agente:e.agente,equipo:e.equipo||"",historial:[]};
    const o=(e.ofertas||[])[0]||{};
    const r=await RC.crearAlternativa(caso,{art:o.codigo||"",desc:o.nombre||""},Object.assign({},alt,{nota:[alt.nota,nota].filter(Boolean).join(" · ")}),por);
    const hoyS=new Date().toLocaleDateString("es-ES");
    const que=`${alt.desc}${alt.cal?" "+alt.cal:""} a ${num(alt.precio)} €/${alt.unidad||"m"}`;
    const campos={estado:"sin_exito",pendienteDe:null,escaladoA:null,
      resolucion:{tipo:"alternativa",por:por.nombre,rol:por.nivel,fecha:hoyS,nota:nota||"",alternativa:que,ref:r.id||""},
      historialEscalado:(e.historialEscalado||[]).concat([{accion:"🔄 Cambiada por alternativa: "+que,por:por.nombre,fecha:hoyS,nota:nota||""}])};
    await RC.guardarEn("estrategias",e._id||e.id,campos,true); Object.assign(e,campos);
    if(r._esEstrategia){ try{ await RC.avisarA(e.agente,`🔄 Alternativa para ${e.cliente}`,`${RC.esc(por.nombre)} propone ${RC.esc(que)} en lugar de ${RC.esc(o.nombre||"")}. Supera su límite: está pendiente de aprobación.`); }catch(x){} }
    return r;
  };
  // Fecha de una estrategia venga de donde venga (las del CRM guardan «fecha»
  // en texto y a veces solo el id lleva la marca de tiempo)
  const deES=(t)=>{ const m=String(t||"").match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if(!m) return 0;
    const y=Number(m[3])<100?2000+Number(m[3]):Number(m[3]); return new Date(y,Number(m[2])-1,Number(m[1]),12).getTime(); };
  RC.fechaEst=(e)=>{
    const a=Date.parse(e.fechaCreacion||""); if(a) return a;
    const b=deES(e.fechaCreacionStr||e.fecha); if(b) return b;
    const m=String(e._id||e.id||"").match(/(1[6-9]\d{11})/); return m?Number(m[1]):0; };
  RC.fechaAprob=(e)=>{
    const a=Date.parse(e.fechaAprobacion||""); if(a) return a;
    const r=deES(e.resolucion&&e.resolucion.tipo==="aprobada"&&e.resolucion.fecha); if(r) return r;
    const h=(e.historialEscalado||[]).filter(x=>/aprobad/i.test(x.accion||"")).map(x=>deES(x.fecha)).filter(Boolean).pop(); if(h) return h;
    return RC.fechaEst(e); };
  RC.fechaTxt=(e)=>{
    const f=RC.fechaEst(e); if(!f) return `<span style="color:#B45309">sin fecha</span>`;
    const d=new Date(f), dias=Math.floor((Date.now()-f)/86400000);
    const txt=d.toLocaleDateString("es-ES",{day:"2-digit",month:"2-digit",year:"numeric"});
    const hace=dias<=0?"hoy":dias===1?"ayer":`hace ${dias} días`;
    const col=e.estado==="pendiente_aprobacion"&&dias>=3?"#B91C1C":"inherit";
    return `${txt} <b style="color:${col}">(${hace})</b>`; };
  RC.htmlEstrategia=(e,botones)=>{
    let [t,c,bg]=RC.ESTADO_EST[e.estado]||["📋 "+(e.estado||""),"#475569","#F8FAFC"];
    const cf=e.cierreFinal, ss=e.seguimientoSemanal;
    if(cf&&cf.resultado==="ko") t="❌ Sin pedido";
    const rz=e.resolucion||{};
    if(rz.tipo==="alternativa"){ t="🔄 Cambiada por alternativa"; c="#C2410C"; bg="#FFF7ED"; }
    const extra=(e.contraoferta?`<div style="font-size:12.5px;font-weight:700;margin-top:4px;color:#1D4ED8">💬 ${RC.esc(e.contraoferta.por)} le da ${RC.esc(e.contraoferta.precio)} € (pedía ${RC.esc(e.contraoferta.antes)} €)</div>`:"")
      +(rz.tipo==="alternativa"?`<div style="font-size:12.5px;font-weight:700;margin-top:4px;color:#C2410C">🔄 ${RC.esc(rz.por)} propone ${RC.esc(rz.alternativa||"")}${rz.nota?" — “"+RC.esc(rz.nota)+"”":""}</div>`:"");
    const res=cf?`<div style="font-size:12.5px;font-weight:700;margin-top:4px;color:${cf.resultado==="pedido"?"#15803D":"#B91C1C"}">${cf.resultado==="pedido"?"✅ Ha entrado pedido":"❌ No ha salido"}${cf.subTipo?" · "+RC.esc((RC.MOTIVOS_KO.find(m=>m[0]===cf.subTipo)||[,cf.subTipo])[1]):""} · ${RC.esc(cf.fecha||"")}${cf.nota?" — “"+RC.esc(cf.nota)+"”":""}</div>`
      :ss&&ss.estado==="pendiente"&&e.estado==="aprobada"?`<div style="font-size:12.5px;font-weight:700;margin-top:4px;color:#B45309">⏳ Sin pedido todavía (semana ${RC.esc(ss.semana)})${ss.nota?" — “"+RC.esc(ss.nota)+"”":""}</div>`:"";
    const o=(e.ofertas||[])[0]||{};
    return `<div style="border:1px solid #E5E7EB;border-radius:12px;padding:10px 12px;margin:8px 0;background:#fff">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap">
        <b style="font-size:13.5px">💶 ${RC.esc(o.nombre||e.estrategia||"Estrategia")}${o.calibre?" · "+RC.esc(o.calibre):""}</b>
        <span style="font-size:11.5px;font-weight:800;color:${c};background:${bg};border-radius:99px;padding:3px 9px">${t}${e.estado==="pendiente_aprobacion"?(()=>{ const q=RC.quienLaTiene(e); return " · "+RC.esc(q.nombre)+(q.antes?" (estaba con "+RC.esc(q.antes)+")":""); })():""}</span></div>
      <div style="font-size:13px;margin-top:4px">${o.precioActual?RC.esc(o.precioActual)+" € → ":o.precioBase?"catálogo "+RC.esc(o.precioBase)+" € → ":""}<b style="color:#6D28D9">${RC.esc(o.precioFinal||o.precioOferta||"")} €/${RC.esc(o.unidad||"m")}</b> · ${e._dtoEf!=null
        ?`<b>${e._dtoEf} % sobre su tarifa</b> <span style="color:#6B7280">(tarifa ${num(e._tarifaCli).toFixed(2)} € · ${e._dtoCli} % ${RC.esc(e._catCli||"")}${e._sinTarifa?" · sin tarifa en el CRM":""} · ${num(e.maxDescuento)} % sobre catálogo)</span>`
        :`descuento ${num(e.maxDescuento)} %`}</div>
      <div style="font-size:12px;color:#6B7280;margin-top:2px">${e.solicitudAgente?"Lo pide "+RC.esc(e.agenteNombre||e.agente):"Creada por "+RC.esc(e.creadoPorNombre||"")} · ${RC.fechaTxt(e)}${e.descripcion?" · “"+RC.esc(e.descripcion)+"”":""}</div>
      ${extra}${res}${botones||""}</div>`;
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
