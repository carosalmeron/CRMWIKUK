/* ══ (oct 2026) FIRMA DIGITAL TÁCTIL ═════════════════════════════════════
   Acta del comité: firman el comercial y el jefe de equipo al cerrar el
   comité (cierre_semanal.html, modo comité) y después el jefe comercial
   (director) desde «Cierre de la semana» (cierres.html). Las firmas se
   guardan como imagen PNG en el documento del acta (cierres_flujo):
     firmaComercial / firmaJefe / firmaDirector  (imagen)
     firmaComercialNombre / …Nombre, firmaComercialEn / …En  (quién y cuándo)
     firmaEstado: "falta_director" | "completa"
*/
window.FIRMA=(function(){
  const esc=(t)=>String(t??"").replace(/[<>&"]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;"}[c]));
  const css=`.fpad{border:1.5px dashed #94A3B8;border-radius:12px;background:#fff;position:relative;touch-action:none;height:150px}
    .fpad canvas{width:100%;height:100%;display:block;border-radius:12px;cursor:crosshair}
    .fpad .fph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#94A3B8;font-size:13px;pointer-events:none}
    .fpad .fln{position:absolute;left:16px;right:16px;bottom:34px;border-bottom:1px solid #CBD5E1;pointer-events:none}
    .fpad.ok{border-style:solid;border-color:#16A34A}
    .fcab{display:flex;align-items:baseline;gap:8px;margin:10px 0 4px;font-size:13px}
    .fcab b{flex:1}.fcab a{font-size:12px;color:#64748B}`;
  function estilos(){ if(document.getElementById("firmaCss")) return; const s=document.createElement("style"); s.id="firmaCss"; s.textContent=css; document.head.appendChild(s); }
  // Monta un recuadro de firma dentro de «cont». onCambio(vacia) cada vez que se firma o se borra.
  function pad(cont,titulo,onCambio){
    estilos();
    const id="fp"+Math.random().toString(36).slice(2,8);
    cont.innerHTML=`<div class="fcab"><b>✍️ ${esc(titulo)}</b><a href="#" id="${id}_b">Borrar</a></div>
      <div class="fpad" id="${id}_w"><div class="fln"></div><div class="fph" id="${id}_p">Firma aquí con el dedo</div><canvas id="${id}"></canvas></div>`;
    const cv=document.getElementById(id), w=document.getElementById(id+"_w"), ph=document.getElementById(id+"_p");
    const ctx=cv.getContext("2d"); let vacia=true, pint=false, ult=null;
    const ajustar=()=>{ const r=cv.getBoundingClientRect(), d=window.devicePixelRatio||1; const img=vacia?null:cv.toDataURL();
      cv.width=Math.max(1,r.width*d); cv.height=Math.max(1,r.height*d); ctx.setTransform(d,0,0,d,0,0);
      ctx.lineWidth=2.4; ctx.lineCap="round"; ctx.lineJoin="round"; ctx.strokeStyle="#0F172A";
      if(img){ const im=new Image(); im.onload=()=>ctx.drawImage(im,0,0,r.width,r.height); im.src=img; } };
    setTimeout(ajustar,0); window.addEventListener("resize",ajustar);
    const pos=(e)=>{ const r=cv.getBoundingClientRect(); return {x:e.clientX-r.left,y:e.clientY-r.top}; };
    cv.addEventListener("pointerdown",e=>{ e.preventDefault(); cv.setPointerCapture(e.pointerId); pint=true; ult=pos(e);
      ctx.beginPath(); ctx.arc(ult.x,ult.y,1.2,0,Math.PI*2); ctx.fillStyle="#0F172A"; ctx.fill(); });
    cv.addEventListener("pointermove",e=>{ if(!pint) return; e.preventDefault(); const p=pos(e);
      ctx.beginPath(); ctx.moveTo(ult.x,ult.y); ctx.lineTo(p.x,p.y); ctx.stroke(); ult=p;
      if(vacia){ vacia=false; ph.style.display="none"; w.classList.add("ok"); } });
    const fin=()=>{ if(!pint) return; pint=false; if(!vacia&&onCambio) onCambio(false); };
    cv.addEventListener("pointerup",fin); cv.addEventListener("pointercancel",fin); cv.addEventListener("pointerleave",fin);
    document.getElementById(id+"_b").onclick=(e)=>{ e.preventDefault(); ctx.clearRect(0,0,cv.width,cv.height); vacia=true; ph.style.display=""; w.classList.remove("ok"); if(onCambio) onCambio(true); };
    return {
      vacia:()=>vacia,
      // PNG recortado y reducido (unos pocos KB)
      imagen:()=>{ if(vacia) return ""; const o=document.createElement("canvas"); const W=420, H=Math.round(W*cv.height/cv.width);
        o.width=W; o.height=H; o.getContext("2d").drawImage(cv,0,0,W,H); return o.toDataURL("image/png"); }
    };
  }
  const fecha=(iso)=>{ const d=new Date(iso||""); return isNaN(d)?"":d.toLocaleDateString("es-ES")+" "+String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0"); };
  // Bloque de firmas del acta (para pantalla y para el documento guardado)
  function bloque(a){
    a=a||{};
    const cas=(img,papel,nom,en)=>`<td style="width:33.3%;vertical-align:top;padding:4px">
      <div style="border:1px solid ${img?"#BBF7D0":"#E2E8F0"};border-radius:10px;padding:8px;background:${img?"#fff":"#F8FAFC"};text-align:center;min-height:118px">
        <div style="font-size:10.5px;font-weight:800;color:#64748B;text-transform:uppercase;letter-spacing:.04em">${esc(papel)}</div>
        ${img?`<img src="${img}" alt="Firma" style="max-width:100%;height:58px;object-fit:contain;display:block;margin:4px auto">`
          :`<div style="height:58px;display:flex;align-items:center;justify-content:center;color:#94A3B8;font-size:12px">Pendiente de firma</div>`}
        <div style="border-top:1px solid #E2E8F0;padding-top:4px;font-size:12px;font-weight:700">${esc(nom||"")}</div>
        <div style="font-size:10.5px;color:#94A3B8">${img?fecha(en):""}</div></div></td>`;
    const ok=a.firmaComercial&&a.firmaJefe&&a.firmaDirector;
    return `<div style="margin-top:14px"><div style="font-size:12px;font-weight:800;color:#6B7684;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">✍️ Firmas ${ok?`<span style="color:#15803D">· firmada por todas las partes</span>`:`<span style="color:#B45309">· falta ${!a.firmaJefe?"el jefe de equipo":!a.firmaComercial?"el comercial":"el jefe comercial"}</span>`}</div>
      <table style="width:100%;border-collapse:collapse;table-layout:fixed"><tr>
        ${cas(a.firmaComercial,"Comercial",a.firmaComercialNombre,a.firmaComercialEn)}
        ${cas(a.firmaJefe,"Jefe de equipo",a.firmaJefeNombre,a.firmaJefeEn)}
        ${cas(a.firmaDirector,"Jefe comercial",a.firmaDirectorNombre,a.firmaDirectorEn)}
      </tr></table></div>`;
  }
  // Para el correo: texto (muchos correos no enseñan imágenes incrustadas)
  function lineaCorreo(a){ a=a||{};
    const t=(img,p,n,en)=>`${img?"✅":"⏳"} ${p}${n?" ("+esc(n)+")":""}${img&&en?" · "+fecha(en):""}`;
    return `<div style="font-size:12.5px;background:#F7F9FB;border-radius:8px;padding:8px 10px;margin-top:12px;line-height:1.7">✍️ <b>Firmas</b><br>
      ${t(a.firmaComercial,"Comercial",a.firmaComercialNombre,a.firmaComercialEn)}<br>${t(a.firmaJefe,"Jefe de equipo",a.firmaJefeNombre,a.firmaJefeEn)}<br>
      ${t(a.firmaDirector,"Jefe comercial",a.firmaDirectorNombre,a.firmaDirectorEn)}${!a.firmaComercial?"<br><b>Comercial: entra en el portal → «Cierre de la semana» → «✍️ Firmar el acta del comité» y fírmala en tu móvil.</b>":a.firmaDirector?"":"<br><span style=\"color:#6B7684\">Falta la firma del jefe comercial. El acta se puede ver en el portal, en «Cierre de la semana».</span>"}</div>`; }
  return {pad,bloque,lineaCorreo,fecha};
})();
