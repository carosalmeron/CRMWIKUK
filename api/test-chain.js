var nodemailer = require('nodemailer');
var https = require('https');
var FB = 'https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents';
function fbGet(col, cb) {
  https.get(FB + '/' + col + '?pageSize=300', function(r) {
    var d = '';
    r.on('data', function(c) { d += c; });
    r.on('end', function() {
      try { var j = JSON.parse(d); var docs = (j.documents || []).map(function(doc) { var o = { id: doc.name.split('/').pop() }; var f = doc.fields || {}; Object.keys(f).forEach(function(k) { var v = f[k]; if (v.stringValue !== undefined) o[k] = v.stringValue; else if (v.integerValue !== undefined) o[k] = parseInt(v.integerValue); else if (v.doubleValue !== undefined) o[k] = parseFloat(v.doubleValue); }); return o; }); cb(null, docs); } catch (e) { cb(null, []); }
    });
  }).on('error', function() { cb(null, []); });
}
module.exports = function handler(req, res) {
  if (!process.env.SMTP_USER) return res.status(503).json({error:'SMTP not configured'});
  var transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST || 'smtp.gmail.com', port: parseInt(process.env.SMTP_PORT || '587'), secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }, tls: { rejectUnauthorized: false } });
  var to = 'info@unitedcaro.com';
  var ok = 0, fail = 0, results = [];
  function send(sub, html, cb) {
    transporter.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: to, subject: sub,
      html: '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)">' + html + '</div>'
    }, function(err) { if (err) { fail++; results.push({s:sub.substring(0,50),st:'FAIL'}); } else { ok++; results.push({s:sub.substring(0,50),st:'OK'}); } cb(); });
  }
  function H(bg,t1,t2,t3){return '<div style="background:'+bg+';color:#fff;padding:18px 22px"><p style="margin:0;font-size:10px;opacity:.5">'+t1+'</p><h3 style="margin:4px 0 0;font-size:16px">'+t2+'</h3>'+(t3?'<p style="margin:4px 0 0;font-size:12px;opacity:.7">'+t3+'</p>':'')+'</div>';}
  function B(c){return '<div style="padding:18px 22px;border:1px solid #E2E8F0;border-top:none;font-size:13px;color:#1E293B;line-height:1.6">'+c+'<div style="margin-top:16px"><a href="https://crmwikuk.vercel.app" style="display:inline-block;padding:10px 22px;background:#1E3A5F;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:12px">Abrir CRM</a></div></div>';}
  function K(items){var c=items.map(function(i){return '<td style="background:'+i.c+'12;border-radius:10px;padding:12px;text-align:center"><p style="margin:0;font-size:20px;font-weight:800;color:'+i.c+'">'+i.v+'</p><p style="margin:2px 0 0;font-size:10px;color:#64748B">'+i.l+'</p></td>';}).join('');return '<table width="100%" cellspacing="6" style="border-collapse:separate;margin-bottom:16px"><tr>'+c+'</tr></table>';}
  function BL(bg,bo,t,items){if(!items.length)return'';return '<div style="margin-bottom:14px;padding:12px 14px;background:'+bg+';border-radius:10px;border-left:4px solid '+bo+'"><p style="margin:0 0 6px;font-size:13px;font-weight:700;color:'+bo+'">'+t+'</p>'+items.map(function(x){return '<p style="margin:3px 0;font-size:12px;color:#475569">'+x+'</p>';}).join('')+'</div>';}
  function TB(rows){return '<table width="100%" style="font-size:12px;color:#475569;border-collapse:collapse">'+rows.map(function(r){return '<tr style="border-bottom:1px solid #E2E8F0"><td style="padding:3px 0">'+r[0]+'</td><td style="text-align:right;font-weight:700">'+r[1]+'</td></tr>';}).join('')+'</table>';}

  var pending = 5, tareas=[], inc=[], est=[], ops=[], muestras=[];
  function loaded(){
    pending--;
    if(pending>0) return;
    var tP=tareas.filter(function(t){return !t.eliminada&&t.estado!=='hecha';}).length;
    var iA=inc.filter(function(i){return !i.eliminada&&i.estado!=='cerrada'&&i.estado!=='resuelta';}).length;
    var eA=est.filter(function(e){return !e.eliminada&&e.estado==='en_curso'&&!e.resolucion;}).length;
    var oA=ops.filter(function(o){return !o.eliminada&&!['ganada','perdida','cerrada_ganada','cerrada_perdida'].includes(o.estado||o.etapa);}).length;
    var mP=muestras.filter(function(m){return !m.eliminada&&m.estado==='pendiente';}).length;
    var pipe=ops.filter(function(o){return !o.eliminada&&!['ganada','perdida','cerrada_ganada','cerrada_perdida'].includes(o.estado||o.etapa);}).reduce(function(s,o){return s+(parseInt(o.valor)||0);},0);
    var emails = [];

    // LUNES - Planificacion
    emails.push({s:'LUN - Azarco abre semana + visitas planificadas',
      h:H('#1E3A5F','LUNES 21/04','Azarco abre semana 17','Planificacion')
      +B('<p style="font-weight:700;color:#1E3A5F">PLANIFICACION SEMANAL</p><p><b>Objetivo:</b> 15 visitas / 3 pedidos / cierre GUILLEN</p><div style="background:#F8FAFC;border-radius:8px;padding:10px;margin:8px 0"><p style="margin:0;font-size:12px;font-weight:700">Agenda:</p><p style="margin:2px 0;font-size:11px">Lun: CHACINAS + AGUILERA</p><p style="margin:2px 0;font-size:11px">Mar: CARNS BERTRAN + UNITED CARO</p><p style="margin:2px 0;font-size:11px">Mie: EMB.MANOLO + CARNAVI + GUILLEN</p><p style="margin:2px 0;font-size:11px">Jue: ARAGONESA + zona norte</p><p style="margin:2px 0;font-size:11px">Vie: Oficina - cierre semanal</p></div>')});

    // LUNES - Visita + incidencia
    emails.push({s:'LUN - Visita CHACINAS + incidencia calidad',
      h:H('#EF4444','LUNES 10:15','Visita CHACINAS CASTILLO','Incidencia detectada')
      +B('<p style="color:#3B82F6;font-weight:700">VISITA</p><p><b>Notas:</b> <i>"Cliente enfadado por ultimo lote. Puntos oscuros en BERRA. Le propongo dto 8% como compensacion."</i></p><hr style="border:none;border-top:1px solid #E2E8F0;margin:10px 0"><p style="color:#EF4444;font-weight:700">INCIDENCIA CREADA</p><p><b>Tipo:</b> Calidad - <b>Subtipo:</b> Reclamacion - <b>Producto:</b> BERRA 45/48 - <b>Lote:</b> LOT-2026-04-A</p>')});

    // MARTES - Muestra enviada
    emails.push({s:'MAR - Visita CARNS BERTRAN + muestra colageno 32mm',
      h:H('#7C3AED','MARTES 9:00','Visita CARNS BERTRAN','Muestra enviada')
      +B('<p style="color:#3B82F6;font-weight:700">VISITA</p><p><b>Notas:</b> <i>"Muy interesado en colageno 32mm FLEX. Su proveedor actual falla en suministro."</i></p><hr style="border:none;border-top:1px solid #E2E8F0;margin:10px 0"><p style="color:#7C3AED;font-weight:700">MUESTRA ENVIADA</p><p>TRIPA COLAGENO 32mm FLEX - 5kg</p>')});

    // MARTES - Muestra rechazada
    emails.push({s:'MAR - Muestra RECHAZADA: COLAGENO 32mm UNITED CARO',
      h:H('#EF4444','MARTES 11:30','Muestra rechazada','Info para I+D')
      +B('<p style="color:#EF4444;font-weight:700">MUESTRA RECHAZADA</p><p><b>Producto:</b> TRIPA COLAGENO 32mm - UNITED CARO</p><p style="color:#DC2626"><b>Motivo:</b> Calidad insuficiente</p><p style="font-style:italic;color:#64748B">"Se rompe en embutido alta velocidad. Necesita mas elasticidad."</p>')});

    // MARTES - Muestra aprobada
    emails.push({s:'MAR - Muestra APROBADA: BERRA Premium GUILLEN',
      h:H('#22C55E','MARTES 16:00','Muestra aprobada','')
      +B('<p style="color:#22C55E;font-weight:700">MUESTRA APROBADA</p><p><b>Producto:</b> BERRA 45/48 PREMIUM - GUILLEN</p><p style="color:#22C55E"><b>Motivo:</b> Calidad superior a competencia</p><p style="font-style:italic;color:#64748B">"Excelente adherencia. Primer pedido 500kg."</p>')});

    // MIERCOLES - Estrategia 8% + aprobacion
    emails.push({s:'MIE - Estrategia 8% CHACINAS + aprobada por Responsable',
      h:H('#F59E0B','MIERCOLES','Estrategia 8% dto','Aprobada por Resp. INTERKEY')
      +B('<p style="color:#F59E0B;font-weight:700">ESTRATEGIA 8% - APROBADA</p><p><b>Cliente:</b> CHACINAS - BERRA 45/48: 14.14 - <b>13.01 EUR</b></p><p>Resp. INTERKEY aprueba (dentro de limite 10%). Azarco ejecuta.</p>')});

    // MIERCOLES - Estrategia 12% escalada
    emails.push({s:'MIE - Estrategia 12% EMB.MANOLO escalada + aprobada Jefe',
      h:H('#3B82F6','MIERCOLES','Dto 12% - Cadena aprobacion','Resp. escala - Jefe aprueba - Resp. OK final')
      +B('<p style="color:#3B82F6;font-weight:700">ESTRATEGIA 12% - CADENA COMPLETA</p><p><b>EMB.MANOLO</b> - BERRA 45/48: 14.14 - <b>12.44 EUR</b></p><p style="color:#64748B">Resp. (escala, limite 10%) - Jefe Ventas (aprueba) - Resp. (OK final pendiente)</p>')});

    // JUEVES - Oportunidad ganada
    emails.push({s:'JUE - OPORTUNIDAD GANADA: GUILLEN 8.500 EUR',
      h:H('#22C55E','JUEVES 10:00','OPORTUNIDAD GANADA','GUILLEN JAMONES')
      +B('<p style="color:#22C55E;font-weight:700;font-size:18px">GANADA</p><p><b>GUILLEN JAMONES</b> - <span style="color:#22C55E;font-size:22px;font-weight:800">8.500 EUR</span></p><p>BERRA Premium 500kg/mes - contrato anual</p>')});

    // JUEVES - Oportunidad perdida
    emails.push({s:'JUE - Oportunidad PERDIDA: CARNAVI - Precio',
      h:H('#DC2626','JUEVES 16:30','Oportunidad perdida','CARNAVI S.L.')
      +B('<p style="color:#DC2626;font-weight:700">PERDIDA</p><p><b>CARNAVI S.L.</b> - 3.200 EUR</p><p style="color:#DC2626"><b>Motivo:</b> Precio (14.14 vs 12.50 competencia + 60 dias pago)</p>')});

    // JUEVES - Hito completado
    emails.push({s:'JUE - Hito completado: prueba industrial CASALBA',
      h:H('#3B82F6','JUEVES 17:00','Hito completado','Proyecto CASALBA')
      +B('<p style="color:#22C55E;font-weight:700">HITO COMPLETADO</p><p><b>Proyecto:</b> CASALBA - <b>Hito:</b> Prueba linea produccion</p><p><i>"Exitosa a 72C/2h. Cliente valida semana que viene."</i></p><p style="color:#3B82F6">Progreso: 60% - 75%</p>')});

    // VIERNES - Incidencia resuelta
    emails.push({s:'VIE - Incidencia RESUELTA: CHACINAS - causa raiz',
      h:H('#22C55E','VIERNES 9:00','Incidencia resuelta','Datos para Calidad')
      +B('<p style="color:#22C55E;font-weight:700">RESUELTA</p><p><b>CHACINAS</b> - BERRA 45/48</p><p><b>Causa:</b> Materia prima defectuosa - <b>Accion:</b> Cambio proveedor</p><p><b>Coste:</b> 340 EUR - <b>Recurrente:</b> <span style="color:#DC2626">Si (4to caso)</span></p>')});

    // ═══════ INFORME SEMANAL AZARCO (EJECUTIVO) ═══════
    emails.push({s:'INFORME SEMANAL AZARCO - Semana 17 INTERKEY',
      h:H('#1E3A5F','INFORME SEMANAL EJECUTIVO','Azarco - Semana 17 - INTERKEY','Cierre de actividad')
      +B(
        K([{v:'14/15',l:'Visitas vs obj.',c:'#3B82F6'},{v:'3',l:'Clientes nuevos',c:'#7C3AED'},{v:'2',l:'Muestras env.',c:'#F59E0B'},{v:'10.590E',l:'Ventas semana',c:'#22C55E'}])

        +'<div style="background:#F0FDF4;border-radius:10px;padding:14px;margin-bottom:14px;border-left:4px solid #22C55E">'
        +'<p style="margin:0 0 8px;font-size:14px;font-weight:800;color:#166534">Ventas vs Objetivo</p>'
        +TB([
          ['Ventas semana','<span style="color:#22C55E;font-size:15px">10.590 EUR</span>'],
          ['Objetivo semanal','9.600 EUR'],
          ['Cumplimiento','<span style="color:#22C55E">110.3% &#9650;</span>'],
          ['Margen bruto medio','31.2%'],
          ['Acumulado mes','24.130 / 38.400 EUR (62.8%)']
        ])+'</div>'

        +K([{v:'1',l:'Ops ganadas',c:'#22C55E'},{v:'1',l:'Ops perdidas',c:'#EF4444'},{v:'1',l:'Hitos OK',c:'#3B82F6'},{v:'0',l:'Hitos aplazados',c:'#F59E0B'}])

        +'<div style="background:#F8FAFC;border-radius:10px;padding:12px;margin-bottom:14px;border-left:4px solid #1E3A5F">'
        +'<p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#1E3A5F">Actividad semanal</p>'
        +TB([
          ['Visitas realizadas','14 / 15 obj. (<span style="color:#22C55E">93%</span>)'],
          ['Llamadas','23'],
          ['Pedidos cerrados','3'],
          ['Clientes nuevos','<span style="color:#7C3AED">3</span> (ARAGONESA + 2 zona norte)'],
          ['Muestras enviadas','2 (COLAGENO 32mm FLEX, BERRA Premium)'],
          ['Muestras resultado','<span style="color:#22C55E">1 OK</span> (GUILLEN) / <span style="color:#DC2626">1 KO</span> (UNITED CARO)'],
          ['Incidencias','1 abierta - 1 resuelta (CHACINAS - calidad)'],
          ['Estrategias activas','2 (CHACINAS 8% aprobada, EMB.MANOLO 12% pend.)']
        ])+'</div>'

        +'<div style="background:#DBEAFE;border-radius:10px;padding:14px;margin-bottom:14px;border-left:4px solid #3B82F6">'
        +'<p style="margin:0 0 10px;font-size:14px;font-weight:800;color:#1E40AF">Proyectos industriales</p>'
        +'<div style="background:#fff;border-radius:8px;padding:10px;margin-bottom:8px">'
        +'<p style="margin:0;font-size:13px;font-weight:700;color:#1E293B">CASALBA - Prueba industrial BERRA 45/48</p>'
        +'<p style="margin:4px 0 0;font-size:12px;color:#475569"><b>Progreso:</b> 60% &#8594; <span style="color:#22C55E;font-weight:700">75%</span></p>'
        +'<p style="margin:2px 0 0;font-size:12px;color:#475569"><b>Hito completado:</b> Prueba en linea de produccion - exitosa a 72C/2h</p>'
        +'<p style="margin:2px 0 0;font-size:12px;color:#475569"><b>Proximo hito:</b> Validacion cliente (resp: Maria Lopez, CASALBA) - sem.18</p>'
        +'<p style="margin:2px 0 0;font-size:11px;color:#64748B;font-style:italic">"El producto mantiene integridad. Cliente validara con su equipo la semana que viene."</p></div>'
        +'<div style="background:#fff;border-radius:8px;padding:10px">'
        +'<p style="margin:0;font-size:13px;font-weight:700;color:#1E293B">EMB.MANOLO VILLADANGOS - Industrializacion BERRA 45/48</p>'
        +'<p style="margin:4px 0 0;font-size:12px;color:#475569"><b>Progreso:</b> <span style="color:#F59E0B;font-weight:700">30%</span></p>'
        +'<p style="margin:2px 0 0;font-size:12px;color:#475569"><b>Hito pendiente:</b> Prueba maquina embutidora (resp: Javier Manolo) - 05/05/2026</p>'
        +'<p style="margin:2px 0 0;font-size:12px;color:#475569"><b>Hitos aplazados:</b> Ninguno</p>'
        +'<p style="margin:2px 0 0;font-size:11px;color:#64748B;font-style:italic">"Pendiente aprobacion dto. 12%. Una vez aprobado, programar prueba en su linea."</p></div>'
        +'</div>'

        +BL('#F0FDF4','#22C55E','Lo mas destacado',[
          '<span style="color:#22C55E;font-weight:700">GUILLEN JAMONES</span> - Cierre 8.500 EUR, contrato anual 500kg/mes BERRA Premium. Contacto: Maria Guillen. <i>"Excelente adherencia, mejor que proveedor actual."</i>',
          '<b>CASALBA</b> - Hito prueba linea completado. Producto resiste 72C/2h sin deformacion. Maria Lopez valida semana 18.',
          '<b>CHACINAS CASTILLO</b> - Incidencia resuelta (causa: materia prima). Dto 8% aprobado como compensacion. Manuel Garcia (jefe prod.) satisfecho con la respuesta.',
          '<b>Zona norte</b> - 2 de 3 carniceros visitados piden muestras colageno 32mm. Mercado sin explotar.'
        ])

        +'<div style="background:#FFFBEB;border-radius:10px;padding:14px;margin-bottom:14px;border-left:4px solid #D97706">'
        +'<p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#92400E">Observaciones clave de las visitas</p>'
        +'<div style="margin-bottom:8px;padding:8px 10px;background:#fff;border-radius:6px"><p style="margin:0;font-size:12px"><b>CHACINAS (Manuel Garcia):</b> <i>"Enfadado por lote defectuoso pero responde bien al dto. 8%. Si cumplimos con calidad, mantiene volumen 300kg/mes."</i></p></div>'
        +'<div style="margin-bottom:8px;padding:8px 10px;background:#fff;border-radius:6px"><p style="margin:0;font-size:12px"><b>EMBUTIDOS AGUILERA (Pedro Aguilera):</b> <i>"Necesita calibre exacto 28.5mm. Nuestra variacion +/-1mm no vale. Hablar con I+D."</i></p></div>'
        +'<div style="margin-bottom:8px;padding:8px 10px;background:#fff;border-radius:6px"><p style="margin:0;font-size:12px"><b>CARNS BERTRAN (Joan Bertran):</b> <i>"Proveedor actual falla suministro. Oportunidad real si muestra va bien. Decision sem.18."</i></p></div>'
        +'<div style="margin-bottom:8px;padding:8px 10px;background:#fff;border-radius:6px"><p style="margin:0;font-size:12px"><b>CARNAVI (Luis Navarro):</b> <i>"Imposible competir en precio: 14.14 vs 12.50 + 60 dias pago. Hay que revisar politica precios zona levante."</i></p></div>'
        +'<div style="padding:8px 10px;background:#fff;border-radius:6px"><p style="margin:0;font-size:12px"><b>ARAGONESA DE PIENSOS (nuevo):</b> <i>"Primer contacto. Buscan proveedor colageno para linea pet food. Volumen potencial 1.000kg/mes. Enviar info tecnica."</i></p></div>'
        +'</div>'

        +BL('#FEE2E2','#EF4444','Alertas / puntos de atencion',[
          '<span style="color:#DC2626;font-weight:700">CARNAVI perdida por precio</span> - Luis Navarro dice que competencia ofrece 12.50 EUR + 60 dias. Propongo revisar precios zona levante con Direccion.',
          '<span style="color:#DC2626;font-weight:700">Materia prima defectuosa</span> - 4to caso este mes con mismo proveedor. Cambio ya en marcha pero seguir monitorizando.',
          '<b>UNITED CARO</b> - Muestra colageno 32mm rechazada: se rompe a alta velocidad. I+D deberia revisar formula elasticidad.',
          '<b>EMB.MANOLO</b> - Dto 12% aprobado por Jefe Ventas pero pendiente OK final Responsable. Sin este OK no puedo avanzar.'
        ])
        +BL('#DBEAFE','#3B82F6','Plan proxima semana (sem.18)',[
          'Lun: Primer envio GUILLEN (500kg BERRA Premium) - coordinar con logistica',
          'Mar: Seguimiento EMB.MANOLO + entregar muestras zona norte',
          'Mie: Llamar CARNS BERTRAN (decision muestra) + CASALBA (validacion)',
          'Jue: Visitar ARAGONESA (presentacion tecnica colageno pet food)',
          'Vie: Cierre semanal + preparar propuesta precios zona levante'
        ])
      )});

    
    // ═══════ INFORME CEO ═══════
    emails.push({s:'PANEL EJECUTIVO CEO - Semana 17',
      h:H('linear-gradient(135deg,#1E3A5F,#0F172A)','PANEL EJECUTIVO','Semana 17 - Grupo Consolidado','Direccion')
      +B(
        K([{v:'87/90',l:'Visitas vs obj.',c:'#3B82F6'},{v:'34',l:'Pedidos',c:'#F59E0B'},{v:'33.5%',l:'MB medio',c:'#22C55E'},{v:(pipe||142500)+'E',l:'Pipeline',c:'#1E3A5F'}])

        +'<div style="background:#F0FDF4;border-radius:10px;padding:14px;margin-bottom:14px;border-left:4px solid #22C55E">'
        +'<p style="margin:0 0 8px;font-size:14px;font-weight:800;color:#166534">Ventas vs Objetivo global</p>'
        +TB([
          ['Ventas semana','<span style="color:#22C55E;font-size:15px">24.790 EUR</span>'],
          ['Objetivo semanal','22.000 EUR'],
          ['Cumplimiento','<span style="color:#22C55E">112.7% &#9650;</span>'],
          ['Acumulado mes','68.420 / 88.000 EUR (77.7%)']
        ])+'</div>'

        +K([{v:'3',l:'Ops ganadas',c:'#22C55E'},{v:'1',l:'Ops perdidas',c:'#EF4444'},{v:'8',l:'Clientes nuevos',c:'#7C3AED'},{v:String(eA||6),l:'Estrategias',c:'#3B82F6'}])

        +'<div style="background:#F8FAFC;border-radius:10px;padding:12px;margin-bottom:14px">'
        +'<p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#1E3A5F">Rendimiento por vendedor</p>'
        +'<table width="100%" style="font-size:11px;color:#475569;border-collapse:collapse">'
        +'<tr style="background:#F0FDF4"><td style="padding:4px 6px;font-weight:700;color:#166534" colspan="6">WIKUK</td></tr>'
        +'<tr style="border-bottom:1px solid #E2E8F0"><td style="padding:3px 6px">David Mag</td><td style="text-align:right">14/15</td><td style="text-align:right">5 ped</td><td style="text-align:right;color:#22C55E;font-weight:700">4.230E</td><td style="text-align:right">34.1%</td><td style="text-align:right;color:#22C55E">109%</td></tr>'
        +'<tr style="border-bottom:1px solid #E2E8F0"><td style="padding:3px 6px">Veronica</td><td style="text-align:right">11/12</td><td style="text-align:right">3 ped</td><td style="text-align:right;color:#22C55E;font-weight:700">1.890E</td><td style="text-align:right">32.5%</td><td style="text-align:right;color:#F59E0B">87%</td></tr>'
        +'<tr style="border-bottom:1px solid #E2E8F0"><td style="padding:3px 6px">Ramon</td><td style="text-align:right">12/12</td><td style="text-align:right">4 ped</td><td style="text-align:right;color:#22C55E;font-weight:700">3.200E</td><td style="text-align:right">33.8%</td><td style="text-align:right;color:#22C55E">106%</td></tr>'
        +'<tr style="border-bottom:1px solid #E2E8F0"><td style="padding:3px 6px;color:#DC2626">Jose Luis</td><td style="text-align:right;color:#DC2626">8/12</td><td style="text-align:right">2 ped</td><td style="text-align:right;color:#EF4444">980E</td><td style="text-align:right;color:#EF4444">29.2%</td><td style="text-align:right;color:#EF4444;font-weight:700">54%</td></tr>'
        +'<tr style="background:#FEF3C7"><td style="padding:4px 6px;font-weight:700;color:#92400E" colspan="6">INTERKEY</td></tr>'
        +'<tr style="border-bottom:1px solid #E2E8F0"><td style="padding:3px 6px">Carlos G.</td><td style="text-align:right">12/12</td><td style="text-align:right">3 ped</td><td style="text-align:right;color:#22C55E;font-weight:700">1.800E</td><td style="text-align:right">31.4%</td><td style="text-align:right;color:#F59E0B">94%</td></tr>'
        +'<tr style="border-bottom:1px solid #E2E8F0"><td style="padding:3px 6px;font-weight:700;color:#1E3A5F">Azarco</td><td style="text-align:right;font-weight:700">14/15</td><td style="text-align:right;font-weight:700">3</td><td style="text-align:right;color:#22C55E;font-weight:800">10.590E</td><td style="text-align:right">31.2%</td><td style="text-align:right;color:#22C55E;font-weight:700">110%</td></tr>'
        +'<tr><td style="padding:3px 6px">Ricardo</td><td style="text-align:right">10/12</td><td style="text-align:right">4 ped</td><td style="text-align:right;color:#22C55E;font-weight:700">2.100E</td><td style="text-align:right">35.0%</td><td style="text-align:right;color:#22C55E">105%</td></tr>'
        +'</table></div>'

        +'<div style="background:#DBEAFE;border-radius:10px;padding:14px;margin-bottom:14px;border-left:4px solid #3B82F6">'
        +'<p style="margin:0 0 10px;font-size:14px;font-weight:800;color:#1E40AF">Proyectos industriales</p>'
        +'<div style="background:#fff;border-radius:8px;padding:10px;margin-bottom:8px">'
        +'<p style="margin:0;font-size:13px"><span style="color:#22C55E;font-weight:700">75%</span> <b>CASALBA</b> - Prueba industrial BERRA 45/48 (Azarco)</p>'
        +'<p style="margin:2px 0 0;font-size:11px;color:#475569">Hito completado: Prueba linea OK 72C/2h. Proximo: Validacion cliente (Maria Lopez, sem.18)</p></div>'
        +'<div style="background:#fff;border-radius:8px;padding:10px;margin-bottom:8px">'
        +'<p style="margin:0;font-size:13px"><span style="color:#F59E0B;font-weight:700">30%</span> <b>EMB.MANOLO</b> - Industrializacion BERRA 45/48 (Azarco)</p>'
        +'<p style="margin:2px 0 0;font-size:11px;color:#475569">Hito pend: Prueba maquina (Javier Manolo, 05/05). Bloqueado por dto 12% pend. OK final.</p></div>'
        +'<div style="background:#fff;border-radius:8px;padding:10px">'
        +'<p style="margin:0;font-size:13px"><span style="color:#F59E0B;font-weight:700">45%</span> <b>ALBARRACIN</b> - Recuperacion cliente (Ricardo)</p>'
        +'<p style="margin:2px 0 0;font-size:11px;color:#475569">Hito pend: Prueba calidad (resp: Ana Albarracin, 02/05). Sin aplazamientos.</p></div>'
        +'</div>'

        +BL('#FEE2E2','#EF4444','Requiere atencion',[
          '<span style="color:#DC2626;font-weight:700">Jose Luis: 54% cumplimiento</span> - Solo 8/12 visitas, 980 EUR ventas, MB 29.2%. Hablar con Resp. WIKUK para plan de accion.',
          '<span style="color:#DC2626;font-weight:700">Materia prima defectuosa: 4to caso mes</span> - Proveedor cambiado pero impacto acumulado 1.240 EUR en incidencias abril.',
          '<span style="color:#F59E0B">CARNAVI perdida por precio</span> - Luis Navarro (CARNAVI): competencia a 12.50 + 60 dias. Revisar politica precios zona levante.',
          '<span style="color:#F59E0B">EMB.MANOLO bloqueado</span> - Dto 12% aprobado por Jefe Ventas pero pendiente OK final Responsable. Proyecto no avanza sin esto.',
          '<span style="color:#F59E0B">UNITED CARO</span> - Muestra colageno 32mm rechazada (rompe). I+D debe revisar elasticidad formula.'
        ])
        +BL('#F0FDF4','#22C55E','Logros de la semana',[
          '<span style="color:#22C55E;font-weight:700">GUILLEN JAMONES - 8.500 EUR</span> contrato anual 500kg/mes BERRA Premium (Azarco). Contacto: Maria Guillen.',
          '<b>Cumplimiento global: 112.7%</b> - 6 de 7 vendedores por encima del 85%.',
          '<b>CASALBA</b> - Prueba industrial exitosa. Potencial cierre sem.18-19.',
          '<b>8 clientes nuevos</b> contactados esta semana (3 Azarco, 3 David Mag, 2 Ricardo).'
        ])

        +'<div style="background:#FFFBEB;border-radius:10px;padding:14px;margin-bottom:14px;border-left:4px solid #D97706">'
        +'<p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#92400E">Inteligencia comercial - notas clave</p>'
        +'<div style="margin-bottom:6px;padding:8px 10px;background:#fff;border-radius:6px"><p style="margin:0;font-size:12px"><b>Azarco (INTERKEY):</b> <i>"GUILLEN cerrado, gran cuenta. Zona norte tiene potencial: 2 carniceros quieren colageno 32mm. ARAGONESA (pet food) puede ser 1.000kg/mes."</i></p></div>'
        +'<div style="margin-bottom:6px;padding:8px 10px;background:#fff;border-radius:6px"><p style="margin:0;font-size:12px"><b>David Mag (WIKUK):</b> <i>"Feria alimentaria: 3 contactos nuevos. Todos del sector iberico, todos piden muestras BERRA Premium."</i></p></div>'
        +'<div style="margin-bottom:6px;padding:8px 10px;background:#fff;border-radius:6px"><p style="margin:0;font-size:12px"><b>Ricardo (INTERKEY):</b> <i>"Albarracin responde bien a nueva propuesta. Ana Albarracin (compras) pide prueba calidad para mayo. Posible pedido 200kg/mes."</i></p></div>'
        +'<div style="padding:8px 10px;background:#fff;border-radius:6px"><p style="margin:0;font-size:12px"><b>Carlos G. (INTERKEY):</b> <i>"CARNS BERTRAN evaluando muestra colageno. Joan Bertran (gerente) decide semana 18. Su proveedor actual falla."</i></p></div>'
        +'</div>'

        +BL('#F5F3FF','#7C3AED','Oportunidades de mercado',[
          '<b>Pet food</b> - ARAGONESA DE PIENSOS busca colageno para nueva linea. Vol. potencial 1.000kg/mes (Azarco)',
          '<b>Zona norte</b> - Mercado sin explotar: 2 carniceros piden muestras (Azarco)',
          '<b>Sector iberico</b> - 3 contactos feria quieren BERRA Premium (David Mag)',
          '<b>Precision calibre</b> - AGUILERA necesita 28.5mm exacto. Si I+D lo resuelve, abre mercado embutido industrial.'
        ])
      )});

    
    // ═══════ INFORME I+D ═══════
    emails.push({s:'INFORME I+D - Semana 17',
      h:H('#2563EB','INFORME I+D','Semana 17','Muestras + Proyectos + Mercado')
      +B(K([{v:'3',l:'Aprobadas',c:'#22C55E'},{v:'1',l:'Rechazadas',c:'#EF4444'},{v:String(mP||12),l:'Pendientes',c:'#F59E0B'},{v:'2',l:'Proyectos',c:'#3B82F6'}])
        +BL('#FEE2E2','#EF4444','Rechazadas - oportunidad mejora',['<b>COLAGENO 32mm</b> (UNITED CARO): <span style="color:#DC2626">Calidad insuficiente</span> - "Rompe en embutido alta velocidad. Revisar elasticidad."'])
        +BL('#F0FDF4','#22C55E','Aprobadas - que funciona',['<b>BERRA 45/48 PREMIUM</b> (GUILLEN): Calidad superior - pedido 500kg/mes','<b>COLAGENO 32mm FLEX</b> (CARNS BERTRAN): En evaluacion, interesado'])
        +BL('#EFF6FF','#3B82F6','Proyectos',['<b>CASALBA</b> 75% - Hito completado: linea produccion OK 72C','<b>EMB.MANOLO</b> 30% - Industrializacion BERRA'])
        +BL('#FFFBEB','#D97706','Oportunidades mercado',['AGUILERA pide calibre exacto 28.5mm (revisar precision)','Zona norte: 2 carniceros piden colageno 32mm'])
      )});

    // ═══════ INFORME CALIDAD ═══════
    emails.push({s:'INFORME CALIDAD - Semana 17',
      h:H('#7C3AED','INFORME CALIDAD','Semana 17','Incidencias + Causas raiz')
      +B(K([{v:String(iA||1),l:'Inc. abiertas',c:'#EF4444'},{v:'1',l:'Rechazadas',c:'#F59E0B'},{v:'3',l:'Aprobadas',c:'#22C55E'}])
        +BL('#FEE2E2','#EF4444','Incidencias calidad',['<b>CHACINAS</b> (Reclamacion) - BERRA 45/48 Lote LOT-2026-04-A - <span style="color:#22C55E">RESUELTA</span>','Causa: Materia prima defectuosa - Accion: Cambio proveedor - Coste: 340 EUR','<span style="color:#DC2626;font-weight:700">RECURRENTE: 4to caso abril</span>'])
        +'<div style="background:#FFFBEB;border-radius:10px;padding:12px;margin-bottom:14px;border-left:4px solid #D97706"><p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#92400E">Causas raiz abril</p>'
        +'<table width="100%" style="font-size:12px;color:#475569;border-collapse:collapse"><tr style="border-bottom:1px solid #E2E8F0"><td style="padding:4px 0">Materia prima defectuosa</td><td style="text-align:right;color:#DC2626;font-weight:700">4 casos - RECURRENTE</td></tr><tr style="border-bottom:1px solid #E2E8F0"><td style="padding:4px 0">Error de proceso</td><td style="text-align:right">2 casos</td></tr><tr><td style="padding:4px 0">Error humano / Fallo maquina</td><td style="text-align:right">2 casos</td></tr></table>'
        +'<p style="margin:8px 0 0;font-size:11px;color:#DC2626;font-weight:700">Coste total abril: 1.240 EUR</p></div>'
        +BL('#FEF3C7','#F59E0B','Muestras rechazadas',['<b>COLAGENO 32mm</b> - UNITED CARO: Calidad insuficiente'])
      )});

    // SEND ALL
    var idx = 0;
    function sendNext() {
      if (idx >= emails.length) {
        return res.status(200).json({test:'SIMULACION SEMANA COMPLETA', destino:to, total:emails.length, ok:ok, fail:fail, firebase:{tareas:tP,inc:iA,est:eA,ops:oA,muestras:mP,pipe:pipe}, detalle:results});
      }
      var e = emails[idx];
      send('[' + (idx+1) + '/' + emails.length + '] ' + e.s, e.h, function() { idx++; sendNext(); });
    }
    sendNext();
  }
  fbGet('tareas',function(e,d){tareas=d||[];loaded();});
  fbGet('incidencias',function(e,d){inc=d||[];loaded();});
  fbGet('estrategias',function(e,d){est=d||[];loaded();});
  fbGet('oportunidades',function(e,d){ops=d||[];loaded();});
  fbGet('muestras',function(e,d){muestras=d||[];loaded();});
};
