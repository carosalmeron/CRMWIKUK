/* ══ (oct 2026) STOCK PROMOCIÓN Y LIQUIDACIÓN · cálculo ═══════════════════
   Traducción a JavaScript de construir_dataset.py (Controlling Financiero),
   con las mismas reglas. Lo usa stock.html: lee los dos Excel en el navegador,
   los deja en un formato compacto (para poder recalcular al cambiar la
   configuración sin volver a subirlos) y genera los datos de la página.
     STOCK.compactarUC(filas)  / STOCK.compactarWK(filas)  → filas compactas
     STOCK.calcular(raw, cfg, ref) → {data, excl, cuadre, resumen}
   cfg = {almacenes:[{cod,nombre,computa,grupo}], rotObj:{A:95,…}, mgDefecto:0.30,
          wkNoComercial:{OTROS:"Otros",…}, equivalencias:{nuevo:antiguo}}
   ref = referencia_modelo.json → codigos {cod:{c,v,f}}
*/
(function(G){
  const ROT_OBJ_DEF={A:95,A1:50,B:70,B1:30,C:30,C1:15,D:0,D1:0,E:0,SA:45,SB:30,SD:0,EA:45,EB:30,ED:0};
  const DIVISION=Object.assign({},...['A','A1','B','B1','C','C1','D','D1','E'].map(k=>({[k]:'Tripa'})),
    {SA:'Especias',SB:'Especias',SD:'Especias',EA:'Envases',EB:'Envases',ED:'Envases',MP:'Materia Prima',P:'Proyecto'});
  const WK_NO_STOCK=new Set(['GASTOS','INMOVILIZADO','INGRESOS/SERVICIOS DIVERSOS','PRECIO MAYOR COMPRA']);
  const WK_NO_COMERCIAL_DEF={OTROS:'Otros',PLEO:'Pleo','CONSUMIBLES VARIOS':'Consumibles varios'};
  const COLS_UC=['Padre','Código Artículo','Nombre Artículo','Nombre Grupo','Almacén','Cantidad Disponible','Valor Costo Lote','Importe Ventas 6M'];
  const COLS_WK=['Producto Padre','Importe Ventas','% Margen','Importe Stock','Unid Stock Actual','ABCDE1','SUBFAMILIA DESC','DESCRIPCION'];

  const vacio=(v)=>v==null||(typeof v==='number'&&isNaN(v))||String(v).trim()==='';
  const txt=(v)=>vacio(v)?null:String(v).trim();
  const norm=(v)=>{ if(v==null||(typeof v==='number'&&isNaN(v))) return ''; const s=String(v).trim().toUpperCase(); return (s==='NAN'||s==='NONE')?'':s; };
  const numN=(v)=>{ if(v==null||v==='') return NaN; if(typeof v==='number') return isFinite(v)?v:NaN; const n=Number(String(v).replace(',','.')); return isFinite(n)?n:NaN; };
  const num0=(v)=>{ const n=numN(v); return isNaN(n)?0:n; };
  const r2=(x)=>Math.round(x*100)/100, r4=(x)=>Math.round(x*10000)/10000;
  const limpiarCab=(filas)=>filas.map(f=>{ const o={}; for(const k of Object.keys(f)) o[String(k).trim()]=f[k]; return o; });

  // Qué fichero es cada uno, por sus columnas
  function tipoFichero(filas){
    const c=new Set(Object.keys(limpiarCab(filas.slice(0,1))[0]||{}));
    if(c.has('Producto Padre')) return {tipo:'wk',faltan:COLS_WK.filter(x=>!c.has(x))};
    if(c.has('Padre')||c.has('Código Artículo')) return {tipo:'uc',faltan:COLS_UC.filter(x=>!c.has(x))};
    return {tipo:null,cols:[...c]};
  }
  // UC compacto: [padre, cod, nombre, grupo, almacén, cantidad, valor, ventas6M, margen|null]
  function compactarUC(filas){
    filas=limpiarCab(filas);
    const colMg=Object.keys(filas[0]||{}).find(c=>/margen/i.test(c));
    return filas.map(f=>{
      const cod=norm(f['Código Artículo']); let padre=norm(f['Padre']); if(!padre) padre=cod;
      let mg=colMg?numN(f[colMg]):NaN; if(!isNaN(mg)&&Math.abs(mg)>1.5) mg=mg/100;
      return [padre,cod,f['Nombre Artículo']==null?'':String(f['Nombre Artículo']),txt(f['Nombre Grupo']),String(f['Almacén']==null?'':f['Almacén']).trim(),
        num0(f['Cantidad Disponible']),num0(f['Valor Costo Lote']),num0(f['Importe Ventas 6M']),isNaN(mg)?null:mg];
    }).filter(x=>x[0]!=='');
  }
  // Wikuk compacto: [P, descripción, calibre, división, ventas, margen, stock, unidades, abcde1, subfamilia]
  function compactarWK(filas){
    filas=limpiarCab(filas);
    return filas.map(f=>[norm(f['Producto Padre']),f['DESCRIPCION']==null?null:f['DESCRIPCION'],f['Calibre']==null?null:f['Calibre'],
      f['DIVISION']==null?'':String(f['DIVISION']).trim().toUpperCase(),numN(f['Importe Ventas']),numN(f['% Margen']),numN(f['Importe Stock']),
      numN(f['Unid Stock Actual']),f['ABCDE1']==null?null:f['ABCDE1'],f['SUBFAMILIA DESC']==null?null:f['SUBFAMILIA DESC']]);
  }

  function calcular(raw,cfg,ref){
    cfg=cfg||{}; ref=ref||{};
    const ROT_OBJ=Object.assign({},ROT_OBJ_DEF,cfg.rotObj||{});
    const MG=cfg.mgDefecto!=null?Number(cfg.mgDefecto):0.30;
    const WKNC=cfg.wkNoComercial||WK_NO_COMERCIAL_DEF;
    const equiv=cfg.equivalencias||{};
    const rev={}; for(const [k,v] of Object.entries(equiv)) (rev[v]=rev[v]||[]).push(k);
    const alm=cfg.almacenes||[];
    const ALM_NOMBRES={}; alm.forEach(a=>ALM_NOMBRES[a.cod]=a.nombre);
    const ALM_EXCL={}; alm.filter(a=>!a.computa).forEach(a=>ALM_EXCL[a.cod]=a.grupo||'Incidencias');

    // ── UC ──
    const U=new Map(), EXCL=[], child2padre=new Map();
    let ucTotal=0, nLineasUC=0;
    const ucRows=raw.uc||null;
    if(ucRows){
      nLineasUC=ucRows.length; ucTotal=ucRows.reduce((t,x)=>t+x[6],0);
      const grupos=[...new Set(Object.values(ALM_EXCL))].sort((a,b)=>{ const o=(g)=>g==='Incidencias'?0:g==='Consigna'?1:9; return o(a)-o(b); });
      for(const g of grupos){
        const alms=[];
        for(const [a,gr] of Object.entries(ALM_EXCL)){ if(gr!==g) continue;
          const x=ucRows.filter(l=>l[4]===a);
          alms.push({alm:a,nombre:ALM_NOMBRES[a]||'',valor:r2(x.reduce((t,l)=>t+l[6],0)),uds:r4(x.reduce((t,l)=>t+l[5],0)),codigos:new Set(x.map(l=>l[0])).size}); }
        alms.sort((a,b)=>b.valor-a.valor);
        const ks=new Set(alms.map(z=>z.alm)), xg=ucRows.filter(l=>ks.has(l[4]));
        EXCL.push({grupo:g+' UC',valor:r2(alms.reduce((t,z)=>t+z.valor,0)),uds:r4(alms.reduce((t,z)=>t+z.uds,0)),codigos:new Set(xg.map(l=>l[0])).size,almacenes:alms});
      }
      // por padre, en orden de aparición
      const porPadre=new Map(); ucRows.forEach(l=>{ if(!porPadre.has(l[0])) porPadre.set(l[0],[]); porPadre.get(l[0]).push(l); });
      for(const [padre,gAll] of porPadre){
        const g=gAll.filter(l=>!(l[4] in ALM_EXCL));
        const hijosAll=[...new Set(gAll.map(l=>l[1]))], hijos=[...new Set(g.map(l=>l[1]))];
        const refG=g.length?g:gAll, propio=refG.filter(l=>l[1]===padre);
        const base=(propio.length?propio:refG).slice().sort((a,b)=>b[6]-a[6])[0];
        const am=new Map(); g.forEach(l=>{ const o=am.get(l[4])||{c:0,v:0}; o.c+=l[5]; o.v+=l[6]; am.set(l[4],o); });
        const almL=[...am.entries()].sort((a,b)=>b[1].v-a[1].v).map(([a,o])=>['UC',a,r4(o.c),r2(o.v)]);
        // ventas: una vez por código artículo (la primera no vacía)
        const va=new Map(); gAll.forEach(l=>{ const o=va.get(l[1])||{pv:null,mg:null}; if(o.pv==null) o.pv=l[7]; if(o.mg==null&&l[8]!=null) o.mg=l[8]; va.set(l[1],o); });
        const vas=[...va.values()];
        const pv6=vas.reduce((t,o)=>t+(o.pv||0),0);
        const conMg=vas.length&&vas.every(o=>o.mg!=null);
        U.set(padre,{pv6,pc6:conMg?vas.reduce((t,o)=>t+(o.pv||0)*(1-o.mg),0):null,hijos,sinLineas:g.length===0,
          nom:String(base[2]),grp:base[3],alm:almL});
        hijosAll.forEach(h=>{ if(!child2padre.has(h)) child2padre.set(h,padre); });
      }
    }

    // ── Wikuk ──
    const W=new Map(); let EXCL_WK=null;
    const wkInfo={filas:0,excluidas:0,neg:0,negVal:0,totalFichero:null,sumaLineas:0,nostockVal:0,negValTotal:0};
    if(raw.wk){
      let d=raw.wk.map(x=>x.slice());
      const tot=d.find(x=>x[0]==='TOTAL'); if(tot) wkInfo.totalFichero=isNaN(tot[6])?null:tot[6];
      d=d.filter(x=>x[0]!=='TOTAL'&&!x[0].startsWith('FILTROS')).filter(x=>!(x[0]===''&&vacio(x[1])));
      const sum=(l,i)=>l.reduce((t,x)=>t+(isNaN(x[i])?0:x[i]),0);
      const excl=(x)=>WK_NO_STOCK.has(x[3])||x[0].startsWith('GAS')||x[0].startsWith('INM');
      wkInfo.sumaLineas=sum(d,6); wkInfo.filas=d.length; wkInfo.excluidas=d.filter(excl).length;
      wkInfo.nostockVal=sum(d.filter(x=>excl(x)&&x[6]>0),6); wkInfo.negValTotal=sum(d.filter(x=>x[6]<0),6);
      d=d.filter(x=>!excl(x));
      const alms=[];
      for(const [k,nombre] of Object.entries(WKNC)){
        const x=d.filter(l=>l[3]===k&&l[6]>0);
        alms.push({alm:nombre,nombre:'División del fichero de Wikuk',valor:r2(sum(x,6)),uds:r4(sum(x,7)),codigos:new Set(x.map(l=>l[0])).size}); }
      alms.sort((a,b)=>b.valor-a.valor);
      const xg=d.filter(l=>(l[3] in WKNC)&&l[6]>0);
      EXCL_WK={grupo:'Otros Wikuk',tipo:'división',valor:r2(alms.reduce((t,z)=>t+z.valor,0)),uds:r4(alms.reduce((t,z)=>t+z.uds,0)),codigos:new Set(xg.map(l=>l[0])).size,almacenes:alms};
      d=d.filter(l=>!(l[3] in WKNC));
      const claveSC=(ds,cal)=>{ const s=String(txt(ds)?ds:'').toUpperCase().replace(/\//g,'-');
        const c=(txt(cal)&&String(cal).trim()!=='.')?String(cal).trim().replace(/\//g,'-'):'';
        return ('SC '+s+(c?' '+c:'')).trim().replace(/\s+/g,' ').slice(0,70); };
      d.forEach(l=>{ if(l[0]==='.'||l[0]==='') l[0]=claveSC(l[1],l[2]); });
      d.forEach(l=>{ const mg=isNaN(l[5])?MG:l[5]; l.vpc=isNaN(l[4])?NaN:l[4]*(1-mg); });
      const neg=d.filter(l=>l[6]<0); wkInfo.neg=neg.length; wkInfo.negVal=sum(neg,6);
      const porP=new Map(); d.forEach(l=>{ if(!porP.has(l[0])) porP.set(l[0],[]); porP.get(l[0]).push(l); });
      for(const [p,g] of porP){
        const s=g.filter(l=>l[6]>0);
        const ord=(L)=>L.slice().sort((a,b)=>(isNaN(b[6])?-Infinity:b[6])-(isNaN(a[6])?-Infinity:a[6]));
        const base=ord(s.length?s:g)[0];
        const cats=g.map(l=>l[8]).filter(c=>c!=null&&!(typeof c==='number'&&isNaN(c))&&String(c).trim()!=='');
        const fams=g.map(l=>l[9]).filter(c=>c!=null&&!(typeof c==='number'&&isNaN(c)));
        W.set(p,{stock:sum(s,6),cant:sum(s,7),nom:txt(base[1])||p,cat:cats.length?String(cats[0]).trim():null,
          fam:fams.length?String(fams[0]).trim():null,pv:Math.max(0,sum(g,4)),pc:Math.max(0,g.reduce((t,l)=>t+(isNaN(l.vpc)?0:l.vpc),0))});
      }
    }

    // ── Unión por código ──
    const destino=(p)=>{ if(U.has(p)) return p; if(child2padre.has(p)) return child2padre.get(p);
      for(const k of (rev[p]||[])){ if(U.has(k)) return k; if(child2padre.has(k)) return child2padre.get(k); } return null; };
    const M=new Map(); for(const p of U.keys()) M.set(p,{uc:U.get(p),wk:[]});
    for(const [p,w] of W){ let t=destino(p); if(t==null){ if(w.stock<=0) continue; t=p; }
      if(!M.has(t)) M.set(t,{uc:U.get(t)||null,wk:[]}); M.get(t).wk.push([p,w]); }
    const R=ref||{};
    const resolver=(cands,hijos)=>{ for(const c of cands) if(c in R) return c;
      for(const c of cands) if(equiv[c]&&equiv[c] in R) return equiv[c];
      let mejor=null; for(const c of hijos){ const k=c in R?c:(equiv[c]&&equiv[c] in R?equiv[c]:null);
        if(k){ const v=R[k].v||0; if(!mejor||v>mejor[0]) mejor=[v,k]; } } return mejor?mejor[1]:null; };
    const famFallback=(g)=>{ if(!g) return null; return String(g).trim().replace(/^\d+\s*-\s*/,'')||null; };
    const data=[];
    for(const [cod,m] of M){
      const u=m.uc, ws=m.wk;
      if(u&&u.sinLineas&&!ws.some(([,w])=>w.stock>0)) continue;
      let stock=0,cant=0; const almL=[];
      if(u){ almL.push(...u.alm); stock+=u.alm.reduce((t,a)=>t+a[3],0); cant+=u.alm.reduce((t,a)=>t+a[2],0); }
      for(const [,w] of ws){ stock+=w.stock; cant+=w.cant; if(w.stock>0) almL.push(['Wikuk','',r4(w.cant),r2(w.stock)]); }
      const hijos=u?u.hijos:[];
      const key=resolver([cod,...ws.map(([p])=>p).filter(p=>p!==cod)],hijos);
      const mod=key?R[key]:null;
      const wkCat=(ws.find(([,w])=>w.cat)||[])[1]; const cat=(wkCat&&wkCat.cat)||(mod?mod.c:null);
      const wkPv=ws.reduce((t,[,w])=>t+w.pv,0), wkPc=ws.reduce((t,[,w])=>t+w.pc,0);
      let uc12=0;
      if(u){ if(u.pc6!=null) uc12=Math.max(0,u.pc6)*2;
        else { const mgRef=wkPv>0?(1-wkPc/wkPv):MG; uc12=Math.max(0,u.pv6)*2*(1-mgRef); } }
      const ventas=uc12+wkPc, ventasPV=(u?Math.max(0,u.pv6)*2:0)+wkPv;
      const rotO=cat&&(cat in ROT_OBJ)?ROT_OBJ[cat]:null;
      const rotA=ventas<=0?(stock>0?99999:0):stock/(ventas/365);
      let estado;
      if(!cat) estado='SIN CATEGORIZAR';
      else if(cat==='MP'||cat==='P') estado='MP/PROYECTO (sin objetivo)';
      else if(rotO==null) estado='SIN CATEGORIZAR';
      else if(rotA>rotO) estado=cat==='E'?'LIQUIDACIÓN':'PROMOCIÓN';
      else estado='OK';
      const wkFam=(ws.find(([,w])=>w.fam)||[])[1]; const wf=wkFam?wkFam.fam:null;
      const grp=(u&&u.grp)?u.grp:wf;
      almL.sort((a,b)=>((a[0]==='UC'?0:1)-(b[0]==='UC'?0:1))||(b[3]-a[3]));
      data.push({cod,nom:u?u.nom:ws[0][1].nom,grp,div:DIVISION[cat]||null,cat,
        fam:(mod&&mod.f)||wf||famFallback(grp),stock:r2(stock),cant:r4(cant),ventas:r2(ventas),ventasPV:r2(ventasPV),
        rotA:r4(rotA),rotO,estado,nh:hijos.length,alm:almL});
    }

    // ── Cuadres y resumen ──
    const tuc=data.reduce((t,r)=>t+r.alm.filter(a=>a[0]==='UC').reduce((s,a)=>s+a[3],0),0);
    const twk=data.reduce((t,r)=>t+r.alm.filter(a=>a[0]==='Wikuk').reduce((s,a)=>s+a[3],0),0);
    const fueraUC=EXCL.reduce((t,x)=>t+x.valor,0);
    const cuadre={uc:ucRows?{excel:ucTotal,fuera:fueraUC,esperado:ucTotal-fueraUC,pagina:tuc,ok:Math.abs(ucTotal-fueraUC-tuc)<1}:null,
      wk:raw.wk?{sumaLineas:wkInfo.sumaLineas,totalFichero:wkInfo.totalFichero,negativos:-wkInfo.negValTotal,gastos:wkInfo.nostockVal,
        otros:EXCL_WK.valor,esperado:wkInfo.sumaLineas-wkInfo.negValTotal-wkInfo.nostockVal-EXCL_WK.valor,pagina:twk,
        ok:Math.abs(wkInfo.sumaLineas-wkInfo.negValTotal-wkInfo.nostockVal-EXCL_WK.valor-twk)<1}:null,
      lineasUC:nLineasUC,wkInfo,ambos:data.filter(r=>new Set(r.alm.map(a=>a[0])).size>1).length,
      almacenesNuevos:ucRows?[...new Set(ucRows.map(l=>l[4]))].filter(a=>a&&!(a in ALM_NOMBRES)).sort():[]};
    const total=data.reduce((t,r)=>t+r.stock,0), porEstado={};
    data.forEach(r=>{ const e=porEstado[r.estado]=porEstado[r.estado]||{codigos:0,valor:0}; e.codigos++; e.valor+=r.stock; });
    return {data,excl:{grupos:EXCL.concat(EXCL_WK?[EXCL_WK]:[]),nombres:ALM_NOMBRES},cuadre,
      resumen:{codigos:data.length,total,uc:tuc,wk:twk,porEstado}};
  }
  // ── (oct 2026) UC desde el stock de SAP que ya se gestiona en el CRM (stock_sap/resumen) ──
  // Lo que hay allí: {código: [stock, entradas, comprometido]} en UNIDADES. El valor a coste, el padre,
  // el almacén y las ventas 6M salen de la base (la última carga completa de UC): coste unitario medio
  // del código (o de su padre), reparto por almacén en la misma proporción y ventas 6M de la base.
  // Si SAP trae líneas completas (con valor), se usan tal cual.
  const sinAc=(s)=>String(s).normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
  const ALIAS={padre:['padre','codigopadre'],cod:['codigoarticulo','codigo','articulo','itemcode','cod','ref'],
    nom:['nombrearticulo','nombre','descripcion','itemname','desc'],grp:['nombregrupo','grupo','familia','itmsgrpnam'],
    alm:['almacen','whscode'],cant:['cantidaddisponible','cantidad','stock','onhand','unidades','disponible'],
    valor:['valorcostolote','valorcoste','valor','importe','importestock','valorstock'],v6:['importeventas6m','ventas6m','ventas'],mg:['margen']};
  function lineasSAP(lineas){
    const k0=Object.keys(lineas[0]||{}), m={};
    for(const [c,al] of Object.entries(ALIAS)){ const k=k0.find(x=>al.includes(sinAc(x))); if(k) m[c]=k; }
    if(!m.cod||!m.cant||!m.valor) return null;
    return lineas.map(f=>{ const cod=norm(f[m.cod]); let padre=m.padre?norm(f[m.padre]):''; if(!padre) padre=cod;
      let mg=m.mg?numN(f[m.mg]):NaN; if(!isNaN(mg)&&Math.abs(mg)>1.5) mg=mg/100;
      return [padre,cod,m.nom&&f[m.nom]!=null?String(f[m.nom]):'',m.grp?txt(f[m.grp]):null,m.alm?String(f[m.alm]==null?'':f[m.alm]).trim():'SAP',
        num0(f[m.cant]),num0(f[m.valor]),m.v6?num0(f[m.v6]):0,isNaN(mg)?null:mg]; }).filter(x=>x[1]!=='');
  }
  function desdeSAP(sap,base){
    sap=sap||{}; base=base||[];
    if(Array.isArray(sap.lineas)&&sap.lineas.length){ const L=lineasSAP(sap.lineas); if(L) return {uc:L,modo:'lineas',info:{lineas:L.length,valor:L.reduce((t,l)=>t+l[6],0)}}; }
    const ex=sap.exact||{}, unid=(a)=>num0(Array.isArray(a)?a[0]:a);
    // Base por código: padre, nombre, grupo, ventas, margen, unidades y valor por almacén
    const B=new Map(), BP=new Map();
    base.forEach(l=>{ const o=B.get(l[1])||{padre:l[0],nom:l[2],grp:l[3],v6:l[7],mg:l[8],cant:0,valor:0,alm:new Map()};
      o.cant+=l[5]; o.valor+=l[6]; const a=o.alm.get(l[4])||[0,0]; a[0]+=l[5]; a[1]+=l[6]; o.alm.set(l[4],a); B.set(l[1],o);
      const p=BP.get(l[0])||{cant:0,valor:0}; p.cant+=l[5]; p.valor+=l[6]; BP.set(l[0],p); });
    const uc=[], sinCoste=[], nuevos=[]; let enBase=0, uds=0;
    for(const [k,a] of Object.entries(ex)){
      const cod=norm(k), cant=unid(a); if(!cod||cant<=0) continue;
      // Código nuevo: padre, nombre y familia del detalle de SAP (stock_sap_detalle: producto base, descripción, familia)
      const d=(sap.detalle&&sap.detalle[cod])||null;
      uds+=cant; const o=B.get(cod); const padre=o?o.padre:(BP.has(cod)?cod:(d&&d.base&&BP.has(d.base)?d.base:(d&&d.base)||cod.split('.')[0]));
      let cu=null; if(o&&o.cant>0&&o.valor>0) cu=o.valor/o.cant; else { const p=BP.get(padre); if(p&&p.cant>0&&p.valor>0) cu=p.valor/p.cant; }
      if(o) enBase++; else nuevos.push(cod);
      if(cu==null) sinCoste.push([cod,cant]);
      const valor=cu==null?0:cant*cu;
      // Reparto por almacén como en la base (así consigna e incidencias siguen fuera del cálculo)
      const reparto=o&&o.cant>0?[...o.alm.entries()].filter(([,x])=>x[0]>0):[];
      if(!reparto.length) uc.push([padre,cod,o?o.nom:(d&&d.desc)||'',o?o.grp:(d&&d.familia)||null,'SAP',cant,valor,o?o.v6:0,o?o.mg:null]);
      else { const tot=reparto.reduce((t,[,x])=>t+x[0],0);
        // cada almacén con su propio coste unitario (lotes distintos); si no lo tiene, el medio del código
        reparto.forEach(([alm,x])=>{ const u=cant*x[0]/tot, c=x[1]>0?x[1]/x[0]:(cu||0); uc.push([padre,cod,o.nom,o.grp,alm,u,u*c,o.v6,o.mg]); }); }
    }
    // Códigos de la base sin stock hoy en SAP: dejan de tener stock, pero sus ventas cuentan si hay stock del padre
    const quitados=[...B.keys()].filter(c=>!(c in ex)||unid(ex[c])<=0);
    return {uc,modo:'unidades',info:{codigos:Object.keys(ex).length,conStock:new Set(uc.map(l=>l[1])).size,enBase,nuevos,sinCoste,uds,
      quitados:quitados.length,valor:uc.reduce((t,l)=>t+l[6],0)}};
  }
  G.STOCK={tipoFichero,compactarUC,compactarWK,calcular,desdeSAP,ROT_OBJ_DEF,WK_NO_COMERCIAL_DEF,COLS_UC,COLS_WK};
})(typeof window!=='undefined'?window:globalThis);
