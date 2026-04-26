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

  var to = process.env.SMTP_USER;

  transporter.sendMail({
    from: to,
    to: to,
    subject: '[TEST 1/17 AZARCO] Incidencia calidad — CHACINAS CASTILLO',
    html: '<div style="font-family:sans-serif;max-width:500px;margin:0 auto"><div style="background:#1E3A5F;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0"><p style="margin:0;font-size:10px;opacity:.6">TEST 1/17 — AZARCO</p><h3 style="margin:4px 0 0;font-size:14px">Incidencia calidad</h3></div><div style="padding:16px 18px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 10px 10px;font-size:13px"><p style="color:#EF4444;font-weight:700">INCIDENCIA CREADA</p><p><b>Subtipo:</b> Reclamacion cliente</p><p><b>Producto:</b> BERRA 45/48 - Lote: LOT-2026-04-A</p><p style="color:#64748B;font-style:italic">Puntos oscuros en el ultimo lote</p></div></div>'
  }, function(err, info) {
    if (err) {
      return res.status(200).json({status:'FAIL', error: err.message});
    }
    return res.status(200).json({status:'OK', message:'Email enviado a ' + to, messageId: info.messageId});
  });
};
