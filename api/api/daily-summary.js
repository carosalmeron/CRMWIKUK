// Vercel Cron Job — Resumen diario por email
// Se ejecuta cada día laborable a las 7:00 AM (hora España)
// 
// Configurar en vercel.json:
// {
//   "crons": [{
//     "path": "/api/daily-summary",
//     "schedule": "0 5 * * 1-5"   ← 5 UTC = 7 AM España
//   }]
// }

const nodemailer = require('nodemailer');

const FB_PROJECT = 'caborana-f1bbb';
const FB_BASE = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.office365.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  tls: { ciphers: 'SSLv3', rejectUnauthorized: false },
});

// Leer colección de Firebase
async function fbLeer(coleccion) {
  try {
    const r = await fetch(`${FB_BASE}/${coleccion}?pageSize=500`);
    const data = await r.json();
    if (!data.documents) return [];
    return data.documents.map(doc => {
      const fields = doc.fields || {};
      const obj = { id: doc.name.split('/').pop() };
      for (const [k, v] of Object.entries(fields)) {
        obj[k] = v.stringValue || v.integerValue || v.doubleValue || v.booleanValue || v.arrayValue || v.mapValue || '';
      }
      return obj;
    });
  } catch (e) {
    console.error(`[SUMMARY] Error reading ${coleccion}:`, e.message);
    return [];
  }
}

module.exports = async function handler(req, res) {
  if (!process.env.SMTP_USER) {
    return res.status(503).json({ error: 'SMTP not configured' });
  }

  console.log('[SUMMARY] Starting daily summary...');

  try {
    // Leer datos
    const [usuarios, tareas, incidencias, estrategias, oportunidades] = await Promise.all([
      fbLeer('usuarios'),
      fbLeer('tareas'),
      fbLeer('incidencias'),
      fbLeer('estrategias'),
      fbLeer('oportunidades'),
    ]);

    // Filtrar usuarios con email
    const usersConEmail = usuarios.filter(u => u.email && u.email.includes('@') && u.activo !== false);
    
    let emailsSent = 0;

    for (const user of usersConEmail) {
      // Tareas pendientes del usuario
      const misTareas = tareas.filter(t => 
        (t.agente === user.id || t.agente === user.grupoAgente) && 
        t.estado !== 'completada' && !t.eliminada
      );
      
      // Incidencias abiertas
      const misInc = incidencias.filter(i => 
        (i.agente === user.id || i.autor === user.id) && 
        i.estado !== 'cerrada' && i.estado !== 'resuelta' && !i.eliminada
      );
      
      // Estrategias activas
      const misEst = estrategias.filter(e => 
        (e.agente === user.id || (!e.equipo && user.rol !== 'agente')) && 
        e.estado === 'en_curso' && !e.eliminada
      );
      
      // Oportunidades sin actividad reciente
      const misOps = oportunidades.filter(o => 
        (o.agente === user.id || o.agenteId === user.id) && 
        !['ganada','perdida','cerrada_ganada','cerrada_perdida'].includes(o.estado || o.etapa) &&
        !o.eliminada
      );

      // Solo enviar si hay algo pendiente
      const total = misTareas.length + misInc.length + misEst.length + misOps.length;
      if (total === 0) continue;

      const hoy = new Date().toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

      const html = `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
          <div style="background:#1E3A5F;color:#fff;padding:20px 24px;border-radius:14px 14px 0 0">
            <h2 style="margin:0 0 4px;font-size:18px">📋 Resumen del día</h2>
            <p style="margin:0;font-size:13px;opacity:.7">${hoy}</p>
          </div>
          <div style="padding:20px 24px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 14px 14px">
            <p style="margin:0 0 16px;font-size:14px;color:#475569">Hola <strong>${user.nombre || user.id}</strong>, aquí tienes tu resumen:</p>
            
            ${misTareas.length > 0 ? `
              <div style="margin-bottom:16px;padding:12px 16px;background:#FEF3C7;border-radius:10px;border-left:4px solid #F59E0B">
                <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#92400E">📌 Tareas pendientes: ${misTareas.length}</p>
                ${misTareas.slice(0, 5).map(t => `<p style="margin:2px 0;font-size:12px;color:#78350F">· ${t.titulo || t.texto || 'Sin título'}</p>`).join('')}
                ${misTareas.length > 5 ? `<p style="margin:4px 0 0;font-size:11px;color:#92400E">...y ${misTareas.length - 5} más</p>` : ''}
              </div>
            ` : ''}
            
            ${misInc.length > 0 ? `
              <div style="margin-bottom:16px;padding:12px 16px;background:#FEE2E2;border-radius:10px;border-left:4px solid #EF4444">
                <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#991B1B">🚨 Incidencias abiertas: ${misInc.length}</p>
                ${misInc.slice(0, 5).map(i => `<p style="margin:2px 0;font-size:12px;color:#7F1D1D">· ${i.titulo || i.asunto || i.tipo || 'Incidencia'} ${i.clienteNombre ? '— ' + i.clienteNombre : ''}</p>`).join('')}
              </div>
            ` : ''}
            
            ${misEst.length > 0 ? `
              <div style="margin-bottom:16px;padding:12px 16px;background:#DBEAFE;border-radius:10px;border-left:4px solid #3B82F6">
                <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#1E40AF">🎯 Estrategias activas: ${misEst.length}</p>
                ${misEst.slice(0, 5).map(e => `<p style="margin:2px 0;font-size:12px;color:#1E3A5F">· ${e.cliente || e.clienteNombre || ''} — ${e.texto || e.objetivo || ''}</p>`).join('')}
              </div>
            ` : ''}
            
            ${misOps.length > 0 ? `
              <div style="margin-bottom:16px;padding:12px 16px;background:#F0FDF4;border-radius:10px;border-left:4px solid #22C55E">
                <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#166534">💼 Oportunidades en pipeline: ${misOps.length}</p>
                ${misOps.slice(0, 5).map(o => `<p style="margin:2px 0;font-size:12px;color:#15803D">· ${o.cliente || o.nombre || 'Oportunidad'}</p>`).join('')}
              </div>
            ` : ''}
            
            <a href="https://crmwikuk.vercel.app" style="display:inline-block;padding:14px 28px;background:#1E3A5F;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px;margin-top:8px">Abrir CRM →</a>
            
            <p style="margin:20px 0 0;font-size:10px;color:#94A3B8;text-align:center">
              Este email se envía automáticamente desde CRM Grupo Consolidado
            </p>
          </div>
        </div>`;

      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: user.email,
          subject: `📋 CRM Resumen: ${misTareas.length} tareas · ${misInc.length} incidencias · ${misEst.length} estrategias`,
          html,
        });
        emailsSent++;
        console.log(`[SUMMARY] Sent to ${user.email} (${user.nombre})`);
      } catch (e) {
        console.error(`[SUMMARY] Failed to send to ${user.email}:`, e.message);
      }
    }

    console.log(`[SUMMARY] Done. ${emailsSent} emails sent.`);
    return res.status(200).json({ ok: true, emailsSent, totalUsers: usersConEmail.length });
  } catch (error) {
    console.error('[SUMMARY] Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
