/* ══ (oct 2026) PROMOCIÓN Y LIQUIDACIÓN en los cierres de la semana ════════
   Lo usan cierre_semanal.html (comercial y comité) y objetivos_equipo.html (jefe).
   · Artículos: los que Stock publica para el catálogo (catalogo_promo: con cantidad propuesta).
   · Clientes: los que compraban el artículo (o su equivalente) y han dejado de comprarlo o compran
     menos este año que el mismo periodo del año pasado (pbi-sync ?clientesArticulo, guardado hasta
     la siguiente sincronización), solo los de los comerciales que se le pasan.
   PROMOC.cargar(agentes) → {items:[{…artículo, clientes:[…], perdido}], fecha}
*/
(function(G){
  const FB='https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents';
  const val=(v)=>!v?null:('stringValue' in v)?v.stringValue:('integerValue' in v)?Number(v.integerValue):('doubleValue' in v)?Number(v.doubleValue):null;
  async function get(id){ const r=await fetch(`${FB}/catalogo_promo/${id}`,{cache:'no-store'}); if(!r.ok) return null; const j=await r.json(); const o={}; for(const [k,v] of Object.entries(j.fields||{})) o[k]=val(v); return o; }
  async function articulos(){
    const m=await get('actual'); if(!m||!m.version) return {items:[],fecha:''};
    let t=''; for(let i=0;i<(Number(m.partes)||1);i++){ const d=await get(`items_${m.version}_${i}`); t+=(d&&d.texto)||''; }
    let items=[]; try{ items=JSON.parse(t||'[]'); }catch(e){}
    return {items,fecha:m.fecha||'',en:m.en||''};
  }
  // De N en N a la vez, para no saturar Power BI la primera vez del día
  async function enTandas(L,n,fn,av){ const out=new Array(L.length); let i=0, h=0; if(av) av(0,L.length);
    await Promise.all([...Array(Math.min(n,L.length))].map(async()=>{ while(i<L.length){ const k=i++; try{ out[k]=await fn(L[k]); }catch(e){ out[k]=null; } h++; if(av) try{ av(h,L.length); }catch(e){} } })); return out; }
  const ARR=(s)=>String(s||'').toUpperCase().trim();
  async function clientesDe(it){
    const mas=(it.eq||[]).length?'&mas='+encodeURIComponent(it.eq.join(',')):'';
    // Con tiempo límite: un artículo que Power BI no contesta no puede dejar el cierre esperando
    const ctl=typeof AbortController!=='undefined'?new AbortController():null, t=setTimeout(()=>{ try{ ctl&&ctl.abort(); }catch(e){} },45000);
    let j; try{ const r=await fetch('/api/pbi-sync?clientesArticulo='+encodeURIComponent(it.cod)+'&top=300'+mas,ctl?{signal:ctl.signal}:{}); j=await r.json(); } finally{ clearTimeout(t); }
    if(j.ok===false) throw new Error(j.error||'sin respuesta'); return j.clientes||[];
  }
  async function cargar(agentes,opts){
    opts=opts||{};
    const A=new Set((agentes||[]).map(ARR).filter(Boolean));
    const {items,fecha}=await articulos();
    const listas=await enTandas(items,opts.tandas||4,clientesDe,opts.alAvanzar);
    const out=items.map((it,i)=>{
      const L=(listas[i]||[]).filter(c=>!A.size||A.has(ARR(c.agente)));
      // Han perdido ventas (este año 0) o se están enfriando (compran menos que el año pasado)
      const caen=L.filter(c=>Number(c.ventasAnt)>0&&Number(c.diferencia)<0).map(c=>Object.assign({},c,{estado:Number(c.ventasAct)<=0?'perdido':'enfria'}))
        .sort((a,b)=>Number(a.diferencia)-Number(b.diferencia));
      return Object.assign({},it,{clientes:caen,perdido:-caen.reduce((t,c)=>t+Number(c.diferencia||0),0),errorClientes:listas[i]==null});
    });
    return {items:out,fecha};
  }
  // Tarifas: carnicero = PVP; fabricante = PVP −10 %. El descuento de promoción va sobre cada tarifa.
  const eur2=(n)=>(Math.round(n*100)/100).toLocaleString('es-ES',{minimumFractionDigits:2,maximumFractionDigits:2})+' €';
  function precios(it){ const b=Number(it.tarifa)||0; if(!(b>0)) return null;
    return {carn:{tar:b,dto:Number(it.dtoGen)||0,p:b*(1-(Number(it.dtoGen)||0)/100)},fab:{tar:b*0.9,dto:Number(it.dtoFab)||0,p:b*0.9*(1-(Number(it.dtoFab)||0)/100)}}; }
  function preciosH(it){ const p=precios(it); if(!p) return '<span style="color:#94A3B8">sin tarifa en el catálogo</span>';
    const l=(n,x)=>`${n} ${x.dto?`<s style="color:#94A3B8">${eur2(x.tar)}</s> <b style="color:#B45309">${eur2(x.p)}</b> −${x.dto}%`:`<b>${eur2(x.tar)}</b>`}`;
    return l('Carn.',p.carn)+' · '+l('Fab.',p.fab); }
  // Familias en el orden del catálogo
  function porFamilia(items){ const m=new Map();
    items.slice().sort((a,b)=>(a.fo??999)-(b.fo??999)||String(a.fam).localeCompare(String(b.fam))||String(a.nom).localeCompare(String(b.nom)))
      .forEach(it=>{ const f=it.fam||'Otros'; if(!m.has(f)) m.set(f,[]); m.get(f).push(it); }); return [...m.entries()]; }
  // Abrir el CRM con la oferta o la estrategia ya rellena (dentro del portal; si no, en otra pestaña)
  function abrirCRM(tipo,it,c,desde){
    const fab=false, p=precios(it), pr=p?(fab?p.fab:p.carn):null;
    const q={nuevo:tipo==='est'?'estrategia':'oferta',desde:desde||'cierre',cli:c.cliente,nom:c.nombre||c.cliente,art:it.cod,desc:it.nom||'',cal:it.cal||'',met:it.met||'',
      pb:pr?pr.tar.toFixed(2):'',pr:pr?pr.p.toFixed(2):'',dto:pr?pr.dto:'',ag:c.agente||'',
      nota:(it.est==='LIQUIDACIÓN'?'Liquidación':'Promoción')+' · −'+(Number(it.dtoGen)||0)+'% sobre tarifa carnicero / −'+(Number(it.dtoFab)||0)+'% sobre tarifa fabricante · '+(Number(it.uds)||0).toLocaleString('es-ES')+' uds disponibles'};
    const qs=Object.keys(q).map(k=>k+'='+encodeURIComponent(q[k])).join('&'), url='/crm.html?'+qs;
    let enMarco=false; try{ enMarco=window.top!==window.self; }catch(e){ enMarco=true; }
    if(enMarco){ let ok=false; const h=(ev)=>{ if(ev&&ev.data&&ev.data.type==='WK_ABRIR_CRM_OK'){ ok=true; window.removeEventListener('message',h); } };
      window.addEventListener('message',h); try{ window.top.postMessage({type:'WK_ABRIR_CRM',query:qs},'*'); }catch(e){}
      setTimeout(()=>{ window.removeEventListener('message',h); if(!ok){ const w=window.open(url,'_blank'); if(!w) location.href=url; } },700); return; }
    location.href=url;
  }
  G.PROMOC={cargar,articulos,precios,preciosH,porFamilia,eur2,abrirCRM};
})(window);
