// sap_pase.js — Pase para las pantallas de SAP con el usuario del portal (sin clave).
// Si no hay pase válido guardado, o una API de SAP contesta 401, sale una ventana para entrar con el usuario y la
// contraseña del portal; se pide el pase a /api/sap-token, se guarda (30 días) y la página se recarga.
(function(){
  var K='sap_pedido_key';
  function get(){ try{ return localStorage.getItem(K)||''; }catch(e){ return ''; } }
  function exp(t){ var m=/^crm\.([A-Za-z0-9_-]+)\./.exec(t||''); if(!m) return 0; try{ return JSON.parse(atob(m[1].replace(/-/g,'+').replace(/_/g,'/'))).exp||0; }catch(e){ return 0; } }
  async function sha(s){ var b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)); return Array.prototype.map.call(new Uint8Array(b),function(x){ return ('0'+x.toString(16)).slice(-2); }).join(''); }
  var abierto=false;
  function ventana(motivo){
    if(abierto) return; abierto=true;
    var d=document.createElement('div');
    d.setAttribute('style','position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,-apple-system,Segoe UI,sans-serif');
    d.innerHTML='<div style="background:#fff;border-radius:16px;max-width:380px;width:100%;padding:18px 18px 14px;box-shadow:0 16px 48px rgba(0,0,0,.3)">'
      +'<div style="font-weight:800;font-size:18px">🔐 Entra con tu usuario del portal</div>'
      +'<div style="font-size:13px;color:#64748B;margin:4px 0 12px">'+(motivo||'Para usar SAP desde aquí. Se recuerda 30 días en este aparato.')+'</div>'
      +'<input id="sp_u" placeholder="Usuario" autocomplete="username" style="width:100%;box-sizing:border-box;font-size:17px;padding:11px;border:2px solid #E2E8F0;border-radius:10px;margin-bottom:8px">'
      +'<input id="sp_p" type="password" placeholder="Contraseña" autocomplete="current-password" style="width:100%;box-sizing:border-box;font-size:17px;padding:11px;border:2px solid #E2E8F0;border-radius:10px">'
      +'<div id="sp_e" style="color:#B91C1C;font-weight:700;font-size:13px;min-height:18px;margin-top:8px"></div>'
      +'<button id="sp_b" style="width:100%;font-size:17px;font-weight:800;padding:12px;border:0;border-radius:10px;background:#0F172A;color:#fff;margin-top:4px">Entrar</button></div>';
    document.body.appendChild(d);
    try{ var pu=JSON.parse(localStorage.getItem('gc_portal_user')||'{}'); if(pu.username||pu.id) document.getElementById('sp_u').value=pu.username||pu.id; }catch(e){}
    var go=async function(){
      var u=document.getElementById('sp_u').value.trim().toLowerCase(), p=document.getElementById('sp_p').value.trim(), E=document.getElementById('sp_e'), B=document.getElementById('sp_b');
      if(!u||!p){ E.textContent='Pon usuario y contraseña'; return; }
      B.disabled=true; B.textContent='Comprobando…'; E.textContent='';
      try{
        var h=await sha(p);
        // El pase va por el id del usuario: si se escribe el nombre de usuario, se busca su id en la lista del portal
        var id=u; try{ var L=JSON.parse(localStorage.getItem('gc_users')||'[]'); var f=L.find(function(x){ return x.id===u||String(x.username||'').toLowerCase()===u||String(x.nombre||'').toLowerCase()===u; }); if(f) id=f.id; }catch(e){}
        var r=await fetch('/api/sap-token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({usuario:id,passHash:h})});
        var j=await r.json().catch(function(){ return {}; });
        if(j&&j.ok&&j.token){ try{ localStorage.setItem(K,j.token); }catch(e){} location.reload(); return; }
        E.textContent=(j&&j.error)||('No se ha podido ('+r.status+')');
      }catch(e){ E.textContent=String(e.message||e); }
      B.disabled=false; B.textContent='Entrar';
    };
    document.getElementById('sp_b').onclick=go;
    document.getElementById('sp_p').onkeydown=function(e){ if(e.key==='Enter') go(); };
  }
  window.pedirPaseSap=ventana;
  // Si una API de SAP dice que no hay permiso, se abre la ventana
  var f0=window.fetch;
  window.fetch=function(u,o){ return f0.apply(this,arguments).then(function(r){ try{ if(r.status===401&&/\/api\/sap-(pedido|factura|produccion|traslado|planificacion)/.test(String(u&&u.url||u))) setTimeout(function(){ ventana('Tu pase no vale o ha caducado. Entra otra vez.'); },0); }catch(e){} return r; }); };
  // Al abrir: si no hay pase o caduca ya, se pide
  if(!(exp(get())>Date.now())) { if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',function(){ ventana(); }); else ventana(); }
})();
