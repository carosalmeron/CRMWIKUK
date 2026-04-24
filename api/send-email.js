// Vercel Serverless Function — Envío de emails via Microsoft 365 SMTP
// Con soporte para adjuntos .ics (eventos de calendario)
//
// CONFIGURACIÓN en Vercel Environment Variables:
//   SMTP_HOST = smtp.office365.com
//   SMTP_PORT = 587
//   SMTP_USER = crm@grupoconsolidado.com
//   SMTP_PASS = (contraseña)
//   SMTP_FROM = CRM Grupo Consolidado <crm@grupoconsolidado.com>

const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.office365.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  tls: { ciphers: 'SSLv3', rejectUnauthorized: false },
});

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { to, subject, html, text, icsAttachment, icsFilename } = req.body;
  if (!to || !subject) return res.status(400).json({ error: 'Missing: to, subject' });
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return res.status(503).json({ error: 'SMTP not configured' });
  }

  try {
    const mailOptions = {
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to, subject,
      html: html || undefined,
      text: text || (html ? undefined : subject),
    };

    // Adjuntar .ics — aparece como evento aceptable en Outlook/Gmail/iOS
    if (icsAttachment) {
      mailOptions.attachments = [{
        filename: icsFilename || 'evento.ics',
        content: icsAttachment,
        contentType: 'text/calendar; method=REQUEST',
      }];
      mailOptions.alternatives = [{
        contentType: 'text/calendar; method=REQUEST',
        content: icsAttachment,
      }];
    }

    const info = await transporter.sendMail(mailOptions);
    console.log('[EMAIL] Sent to', to, ':', subject);
    return res.status(200).json({ ok: true, messageId: info.messageId });
  } catch (error) {
    console.error('[EMAIL] Error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};
