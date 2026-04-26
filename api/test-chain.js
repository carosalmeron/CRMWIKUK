var nodemailer = require('nodemailer');

module.exports = function handler(req, res) {
  if (!process.env.SMTP_USER) {
    return res.status(503).json({error:'SMTP not configured'});
  }

  var transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls: { rejectUnauthorized: false }
  });

  var to = "info@unitedcaro.com";
  var emails = [
    {r:'AZARCO',n:'01',s:'Incidencia calidad - CHACINAS CASTILLO',b:'<p style="color:#EF4444;font-weight:700">INCIDENCIA CREADA</p><p><b>Subtipo:</b> Reclamacion cliente</p><p><b>Producto:</b> BERRA 45/48 - <b>Lote:</b> LOT-2026-04-A - <b>Prioridad:</b> Alta</p><p style="color:#64748B;font-style:italic">Puntos oscuros en el ultimo lote</p><p style="font-size:11px;color:#94A3B8">De: Azarco - Dest: Resp. INTERKEY</p>'},
    {r:'AZARCO',n:'02',s:'Incidencia resuelta: CHACINAS',b:'<p style="color:#22C55E;font-weight:700">INCIDENCIA RESUELTA</p><p><b>Causa raiz:</b> Materia prima defectuosa</p><p><b>Accion:</b> Cambio de proveedor</p><p><b>Coste:</b> 340 EUR - <b>Recurrente:</b> <span style="color:#DC2626">Si</span></p>'},
    {r:'AZARCO',n:'03',s:'Muestra rechazada: TRIPA COLAGENO 32mm',b:'<p style="color:#EF4444;font-weight:700">MUESTRA RECHAZADA</p><p><b>Producto:</b> TRIPA COLAGENO 32mm - UNITED CARO</p><p style="color:#DC2626"><b>Motivo:</b> Calidad insuficiente</p><p style="color:#64748B;font-style:italic">Se rompe durante el embutido a alta velocidad</p>'},
    {r:'AZARCO',n:'04',s:'Muestra positiva: BERRA 45/48 - GUILLEN',b:'<p style="color:#22C55E;font-weight:700">MUESTRA APROBADA</p><p><b>Producto:</b> BERRA 45/48 PREMIUM - GUILLEN</p><p style="color:#22C55E"><b>Motivo:</b> Calidad superior a competencia</p><p style="color:#64748B;font-style:italic">Excelente adherencia. Primer pedido 200kg</p>'},
    {r:'AZARCO',n:'05',s:'Aprobacion: CHACINAS (dto. 8%)',b:'<p style="color:#F59E0B;font-weight:700">APROBACION REQUERIDA</p><p><b>Cliente:</b> CHACINAS CASTILLO - <b>Dto:</b> <span style="color:#22C55E">8%</span></p><p><b>BERRA 45/48:</b> 14.14 - <b>13.01 EUR</b></p><p style="color:#64748B">Cadena: <span style="color:#F59E0B">Resp. INTERKEY</span> - Azarco</p>'},
    {r:'RESP.INTERKEY',n:'06',s:'Aprobada: CHACINAS (8%)',b:'<p style="color:#22C55E;font-weight:700">ESTRATEGIA APROBADA</p><p>CHACINAS CASTILLO - Dto 8% aprobado. Ya puedes ejecutarla.</p><p style="color:#64748B">Resp. INTERKEY - Azarco</p>'},
    {r:'RESP.INTERKEY',n:'07',s:'Escalada: EMB.MANOLO (dto. 12%)',b:'<p style="color:#3B82F6;font-weight:700">ESCALADA A JEFE VENTAS</p><p><b>Cliente:</b> EMB.MANOLO - <b>Dto:</b> <span style="color:#F59E0B">12%</span> (mi limite: 10%)</p><p style="color:#64748B">Resp. - Jefe Ventas - Resp. OK final - Azarco</p>'},
    {r:'JEFE VENTAS',n:'08',s:'Aprobado 12% - OK final: EMB.MANOLO',b:'<p style="color:#22C55E;font-weight:700">DTO APROBADO - TU OK FINAL</p><p>Jefe Ventas aprueba 12% para EMB.MANOLO</p><p><b>Da tu OK final</b> para que llegue al comercial.</p><p style="color:#64748B">Jefe Ventas - Resp. (OK final) - Azarco</p>'},
    {r:'JEFE VENTAS',n:'09',s:'Escalada CEO: CARNS BERTRAN (dto. 20%)',b:'<p style="color:#DC2626;font-weight:700">ESCALADA AL CEO</p><p><b>Cliente:</b> CARNS BERTRAN - <b>Dto:</b> <span style="color:#DC2626">20%</span> (mi limite: 15%)</p><p style="color:#64748B">Resp. - Jefe - CEO - Resp. OK final - Azarco</p>'},
    {r:'CEO',n:'10',s:'CEO aprueba 20%: CARNS BERTRAN',b:'<p style="color:#22C55E;font-weight:700">CEO HA APROBADO 20%</p><p>CARNS BERTRAN - falta OK final Responsable.</p><p style="color:#64748B">CEO - Resp. (OK final) - Azarco</p>'},
    {r:'CEO',n:'11',s:'CEO crea estrategia - Resp. OK',b:'<p style="color:#7C3AED;font-weight:700">ESTRATEGIA DEL CEO</p><p><b>Cliente:</b> ARAGONESA DE PIENSOS</p><p>Recuperar cliente - nueva gama colageno. Da tu OK para que llegue a Azarco.</p><p style="color:#64748B">CEO - Resp. INTERKEY - Azarco</p>'},
    {r:'AZARCO',n:'12',s:'GANADA: GUILLEN - 8.500 EUR',b:'<p style="color:#22C55E;font-weight:700;font-size:16px">OPORTUNIDAD GANADA</p><p><b>Cliente:</b> GUILLEN JAMONES - <b>Valor:</b> <span style="color:#22C55E;font-size:18px">8.500 EUR</span></p>'},
    {r:'AZARCO',n:'13',s:'PERDIDA: CARNAVI - Precio',b:'<p style="color:#DC2626;font-weight:700">OPORTUNIDAD PERDIDA</p><p><b>Cliente:</b> CARNAVI S.L. - <b>Valor:</b> 3.200 EUR</p><p style="color:#DC2626"><b>Motivo:</b> Precio - competencia 12.50 vs 14.14 EUR/kg</p>'},
    {r:'AZARCO',n:'14',s:'Hito completado: CASALBA',b:'<p style="color:#22C55E;font-weight:700">HITO COMPLETADO</p><p><b>Proyecto:</b> Prueba industrial CASALBA</p><p><b>Hito:</b> Prueba en linea de produccion</p>'},
    {r:'JEFE VENTAS',n:'15',s:'Proyecto sin exito: CASALBA',b:'<p style="color:#DC2626;font-weight:700">PROYECTO SIN EXITO</p><p><b>Proyecto:</b> CASALBA - <b>Motivo:</b> Prueba industrial fallida</p><p style="color:#64748B;font-style:italic">Tripa no resiste ahumado 85C durante 4h</p>'},
    {r:'AZARCO',n:'16',s:'Tarea completada: Visitar CHACINAS',b:'<p style="color:#22C55E;font-weight:700">TAREA COMPLETADA</p><p>Visitar CHACINAS CASTILLO - entrega catalogo</p>'},
    {r:'RESP.INTERKEY',n:'17',s:'Estrategia rechazada: CARNAVI',b:'<p style="color:#DC2626;font-weight:700">ESTRATEGIA RECHAZADA</p><p><b>Cliente:</b> CARNAVI S.L.</p><p style="color:#DC2626"><b>Motivo:</b> Descuento excesivo. Proponer 5% max.</p>'}
  ];

  var ok = 0;
  var fail = 0;
  var results = [];
  var idx = 0;

  function next() {
    if (idx >= emails.length) {
      return res.status(200).json({test:'CADENA COMPLETA', email:to, total:emails.length, ok:ok, fail:fail, detalle:results});
    }
    var e = emails[idx];
    var html = '<div style="font-family:sans-serif;max-width:500px;margin:0 auto">'
      + '<div style="background:#1E3A5F;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0">'
      + '<p style="margin:0;font-size:10px;opacity:.6">TEST ' + e.n + '/17 - ' + e.r + '</p>'
      + '<h3 style="margin:4px 0 0;font-size:14px">' + e.s + '</h3></div>'
      + '<div style="padding:16px 18px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 10px 10px;font-size:13px">'
      + e.b
      + '<hr style="border:none;border-top:1px solid #E2E8F0;margin:12px 0">'
      + '<a href="https://crmwikuk.vercel.app" style="display:inline-block;padding:10px 20px;background:#1E3A5F;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:12px">Abrir CRM</a>'
      + '</div></div>';

    transporter.sendMail({
      from: to, to: to,
      subject: '[TEST ' + e.n + '/17 ' + e.r + '] ' + e.s,
      html: html
    }, function(err) {
      if (err) { fail++; results.push({n:e.n, r:e.r, st:'FAIL', err:err.message}); }
      else { ok++; results.push({n:e.n, r:e.r, st:'OK'}); }
      idx++;
      next();
    });
  }

  next();
};
