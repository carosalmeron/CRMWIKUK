const nodemailer = require('nodemailer');
module.exports = async function handler(req, res) {
  const host = process.env.SMTP_HOST || '(no configurado)';
  const port = process.env.SMTP_PORT || '(no configurado)';
  const user = process.env.SMTP_USER || '(no configurado)';
  const pass = process.env.SMTP_PASS ? '****' + process.env.SMTP_PASS.slice(-4) : '(no configurado)';
  const passLen = process.env.SMTP_PASS ? process.env.SMTP_PASS.length : 0;
  const hasSpaces = process.env.SMTP_PASS ? process.env.SMTP_PASS.includes(' ') : false;
  const diag = { config: { host, port, user, pass_length: passLen, pass_has_spaces: hasSpaces, pass_preview: pass }, tests: [] };
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    diag.tests.push({ test: 'Variables SMTP', result: 'FAIL', detail: 'Faltan SMTP_USER o SMTP_PASS' });
    return res.status(200).json(diag);
  }
  diag.tests.push({ test: 'Variables SMTP', result: 'OK' });
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 10000,
  });
  try {
    await transporter.verify();
    diag.tests.push({ test: 'Conexion SMTP', result: 'OK', detail: 'Autenticacion exitosa' });
  } catch (e) {
    diag.tests.push({ test: 'Conexion SMTP', result: 'FAIL', detail: e.message });
    if (e.message.includes('BadCredentials') || e.message.includes('not accepted')) {
      diag.fix = 'Contrasena no valida. Para Gmail: 1) Activa verificacion en 2 pasos 2) Genera App Password en myaccount.google.com/apppasswords 3) Copia 16 letras SIN espacios';
    }
    return res.status(200).json(diag);
  }
  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_USER, to: process.env.SMTP_USER,
      subject: 'CRM Test - Email funcionando',
      html: '<h2>El email del CRM funciona</h2><p>Fecha: ' + new Date().toLocaleString('es-ES') + '</p>',
    });
    diag.tests.push({ test: 'Envio email', result: 'OK', detail: 'Enviado a ' + process.env.SMTP_USER, messageId: info.messageId });
  } catch (e) {
    diag.tests.push({ test: 'Envio email', result: 'FAIL', detail: e.message });
  }
  return res.status(200).json(diag);
};

