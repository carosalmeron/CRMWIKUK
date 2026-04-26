// /api/test-chain.js — Prueba completa de toda la cadena de notificaciones
// Abre en el navegador: https://crmwikuk.vercel.app/api/test-chain
// Envía emails REALES simulando cada rol

const nodemailer = require(‘nodemailer’);

module.exports = async function handler(req, res) {
if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
return res.status(503).json({error:‘SMTP not configured’});
}

const transporter = nodemailer.createTransport({
host: process.env.SMTP_HOST || ‘smtp.gmail.com’,
port: parseInt(process.env.SMTP_PORT || ‘587’),
secure: false,
auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
tls: { rejectUnauthorized: false },
});

// Destino: todos los emails van al SMTP_USER para la prueba
const testEmail = process.env.SMTP_USER;
const results = [];
let ok = 0, fail = 0;

async function enviar(rol, accion, subject, html) {
try {
await transporter.sendMail({
from: process.env.SMTP_FROM || process.env.SMTP_USER,
to: testEmail,
subject: ’[TEST ’ + rol + ’] ’ + subject,
html: ‘<div style="font-family:sans-serif;max-width:500px;margin:0 auto">’
+ ‘<div style="background:#1E3A5F;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0">’
+ ’<p style="margin:0;font-size:11px;opacity:.6">TEST CADENA — ’ + rol + ‘</p>’
+ ‘<h3 style="margin:4px 0 0;font-size:15px">’ + accion + ‘</h3></div>’
+ ‘<div style="padding:16px 18px;border:1px solid #E2E8F0;border-top:none;border-radius:0 0 10px 10px">’
+ html
+ ‘<p style="margin:16px 0 0;font-size:10px;color:#94A3B8">Email de prueba — CRM Grupo Consolidado</p>’
+ ‘</div></div>’,
});
results.push({ rol, accion, status: ‘OK’ });
ok++;
} catch (e) {
results.push({ rol, accion, status: ‘FAIL’, error: e.message });
fail++;
}
}

// ═══════════════════════════════════════
// SIMULACIÓN COMPLETA
// ═══════════════════════════════════════

// 1. AZARCO crea incidencia de calidad → notifica al Jefe INTERKEY
await enviar(‘AZARCO (Comercial)’, ‘1. Crea incidencia de calidad’,
‘Incidencia: Reclamacion calidad — CHACINAS CASTILLO’,
‘<p style="margin:0 0 4px;font-size:11px;color:#64748B;text-transform:uppercase;font-weight:700">INCIDENCIA</p>’
+ ‘<h3 style="margin:0 0 8px;font-size:16px;color:#1E293B">Reclamacion cliente — CHACINAS CASTILLO</h3>’
+ ‘<p style="margin:0 0 4px;font-size:13px;color:#475569"><b>Subtipo:</b> Reclamacion cliente</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px;color:#475569"><b>Producto:</b> BERRA 45/48 90M</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px;color:#475569"><b>Lote:</b> LOT-2026-04-A</p>’
+ ‘<p style="margin:0 0 8px;font-size:13px;color:#475569"><b>Prioridad:</b> Alta</p>’
+ ‘<p style="margin:0;font-size:12px;color:#64748B;font-style:italic">“Puntos oscuros en el ultimo lote”</p>’
+ ‘<p style="margin:8px 0 0;font-size:11px;color:#94A3B8">De: Azarco — Destinatario: Resp. INTERKEY</p>’
);

// 2. AZARCO cierra incidencia → notifica al autor
await enviar(‘AZARCO (Comercial)’, ‘2. Cierra incidencia con causa raiz’,
‘Incidencia resuelta: CHACINAS CASTILLO’,
‘<p style="margin:0 0 4px;font-size:11px;color:#22C55E;font-weight:700">INCIDENCIA RESUELTA</p>’
+ ‘<p style="margin:0 0 8px;font-size:13px"><b>Causa raiz:</b> Materia prima defectuosa</p>’
+ ‘<p style="margin:0 0 8px;font-size:13px"><b>Accion correctiva:</b> Cambio de proveedor</p>’
+ ‘<p style="margin:0 0 8px;font-size:13px"><b>Coste:</b> 340 EUR · <b>Recurrente:</b> <span style="color:#DC2626">Si</span></p>’
);

// 3. AZARCO registra muestra rechazada → I+D info
await enviar(‘AZARCO (Comercial)’, ‘3. Muestra RECHAZADA’,
‘Muestra rechazada: TRIPA COLAGENO 32mm — UNITED CARO’,
‘<p style="margin:0 0 8px;font-size:11px;color:#EF4444;font-weight:700">MUESTRA RECHAZADA</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Producto:</b> TRIPA COLAGENO 32mm</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Cliente:</b> UNITED CARO SLU</p>’
+ ‘<p style="margin:0 0 8px;font-size:13px;color:#DC2626"><b>Motivo:</b> Calidad insuficiente</p>’
+ ‘<p style="margin:0;font-size:12px;color:#64748B;font-style:italic">“Se rompe durante el embutido a alta velocidad”</p>’
);

// 4. AZARCO registra muestra aprobada → Jefe info
await enviar(‘AZARCO (Comercial)’, ‘4. Muestra APROBADA’,
‘Muestra positiva: BERRA 45/48 PREMIUM — GUILLEN’,
‘<p style="margin:0 0 8px;font-size:11px;color:#22C55E;font-weight:700">MUESTRA APROBADA</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Producto:</b> BERRA 45/48 PREMIUM</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Cliente:</b> GUILLEN JAMONES</p>’
+ ‘<p style="margin:0 0 8px;font-size:13px;color:#22C55E"><b>Motivo:</b> Calidad superior a competencia</p>’
+ ‘<p style="margin:0;font-size:12px;color:#64748B;font-style:italic">“Excelente adherencia y brillo. Primer pedido 200kg”</p>’
);

// 5. AZARCO crea estrategia con 8% dto → Resp. INTERKEY
await enviar(‘AZARCO (Comercial)’, ‘5. Estrategia 8% dto → Responsable aprueba’,
‘Aprobacion requerida: CHACINAS CASTILLO (dto. 8%)’,
‘<p style="margin:0 0 8px;font-size:11px;color:#F59E0B;font-weight:700">APROBACION REQUERIDA</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Cliente:</b> CHACINAS CASTILLO</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Descuento max:</b> <span style="color:#22C55E;font-weight:700">8%</span></p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Producto:</b> BERRA 45/48 — Tarifa: 14.14 EUR → <b>13.01 EUR</b></p>’
+ ‘<p style="margin:0 0 8px;font-size:12px;color:#64748B">Cadena: <span style="color:#F59E0B">⏳ Resp. INTERKEY</span> → Azarco</p>’
+ ‘<p style="margin:0;font-size:11px;color:#94A3B8">De: Azarco — Nivel: Responsable (≤10%)</p>’
);

// 6. RESP. INTERKEY aprueba 8% → Azarco
await enviar(‘RESP. INTERKEY (Jefe)’, ‘6. Aprueba 8% → comercial ejecuta’,
‘Estrategia aprobada: CHACINAS CASTILLO’,
‘<p style="margin:0 0 8px;font-size:11px;color:#22C55E;font-weight:700">ESTRATEGIA APROBADA</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Cliente:</b> CHACINAS CASTILLO</p>’
+ ‘<p style="margin:0 0 8px;font-size:13px">Descuento 8% aprobado. Ya puedes ejecutarla.</p>’
+ ‘<p style="margin:0;font-size:12px;color:#64748B">Cadena: <span style="color:#22C55E">✅ Resp. INTERKEY</span> → Azarco</p>’
);

// 7. AZARCO crea estrategia con 12% → Resp no puede → escala a Jefe Ventas
await enviar(‘RESP. INTERKEY (Jefe)’, ‘7. Escala 12% al Jefe de Ventas’,
‘Estrategia escalada: EMB.MANOLO (dto. 12%)’,
‘<p style="margin:0 0 8px;font-size:11px;color:#3B82F6;font-weight:700">ESTRATEGIA ESCALADA</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Cliente:</b> EMB.MANOLO VILLADANGOS</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Descuento:</b> <span style="color:#F59E0B;font-weight:700">12%</span> (mi limite: 10%)</p>’
+ ‘<p style="margin:0 0 8px;font-size:12px;color:#64748B">Cadena: <span style="color:#F59E0B">📤 Resp. INTERKEY</span> → <span style="color:#F59E0B">⏳ Jefe Ventas</span> → Resp. INTERKEY (OK final) → Azarco</p>’
+ ‘<p style="margin:0;font-size:11px;color:#94A3B8">De: Resp. INTERKEY — Destinatario: Jefe de Ventas</p>’
);

// 8. JEFE VENTAS aprueba 12% → vuelve a Resp. para OK final
await enviar(‘JEFE VENTAS (Director)’, ‘8. Aprueba 12% → Responsable OK final’,
‘Dto. aprobado — tu OK final: EMB.MANOLO’,
‘<p style="margin:0 0 8px;font-size:11px;color:#22C55E;font-weight:700">DESCUENTO APROBADO — TU OK FINAL</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Cliente:</b> EMB.MANOLO VILLADANGOS</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px">El descuento de 12% ha sido aprobado por Jefe de Ventas.</p>’
+ ‘<p style="margin:0 0 8px;font-size:13px"><b>Da tu OK final</b> para que llegue al comercial.</p>’
+ ‘<p style="margin:0;font-size:12px;color:#64748B">Cadena: <span style="color:#22C55E">✅ Jefe Ventas</span> → <span style="color:#F59E0B">🔄 Resp. INTERKEY (OK final)</span> → Azarco</p>’
);

// 9. AZARCO crea estrategia con 20% → necesita CEO
await enviar(‘JEFE VENTAS (Director)’, ‘9. Escala 20% al CEO’,
‘Estrategia escalada al CEO: CARNS BERTRAN (dto. 20%)’,
‘<p style="margin:0 0 8px;font-size:11px;color:#DC2626;font-weight:700">ESTRATEGIA ESCALADA AL CEO</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Cliente:</b> CARNS BERTRAN S.L.</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Descuento:</b> <span style="color:#DC2626;font-weight:700">20%</span> (mi limite: 15%)</p>’
+ ‘<p style="margin:0;font-size:12px;color:#64748B">Cadena: 📤 Resp. → 📤 Jefe Ventas → <span style="color:#DC2626">⏳ CEO</span> → Resp. (OK final) → Azarco</p>’
);

// 10. CEO aprueba 20%
await enviar(‘CEO’, ‘10. CEO aprueba 20% → vuelve a Responsable’,
‘CEO aprueba dto. 20%: CARNS BERTRAN’,
‘<p style="margin:0 0 8px;font-size:11px;color:#22C55E;font-weight:700">CEO HA APROBADO</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px">Descuento 20% aprobado para CARNS BERTRAN.</p>’
+ ‘<p style="margin:0 0 8px;font-size:13px">Falta tu OK final como Responsable.</p>’
+ ‘<p style="margin:0;font-size:12px;color:#64748B">Cadena: <span style="color:#22C55E">✅ CEO</span> → <span style="color:#F59E0B">🔄 Resp. INTERKEY (OK final)</span> → Azarco</p>’
);

// 11. CEO crea estrategia para Azarco → Responsable OK
await enviar(‘CEO’, ‘11. CEO crea estrategia → Responsable OK’,
‘Nueva estrategia del CEO para tu equipo’,
‘<p style="margin:0 0 8px;font-size:11px;color:#7C3AED;font-weight:700">ESTRATEGIA DEL CEO</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Cliente:</b> ARAGONESA DE PIENSOS</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Accion:</b> Recuperar cliente — ofrecer nueva gama colageno</p>’
+ ‘<p style="margin:0 0 8px;font-size:13px">El CEO ha creado esta estrategia. Da tu OK para que llegue a Azarco.</p>’
+ ‘<p style="margin:0;font-size:12px;color:#64748B">Cadena: CEO → <span style="color:#F59E0B">⏳ Resp. INTERKEY</span> → Azarco</p>’
);

// 12. OPORTUNIDAD GANADA → notifica al jefe
await enviar(‘AZARCO (Comercial)’, ‘12. Oportunidad GANADA’,
‘Oportunidad GANADA: GUILLEN JAMONES — 8.500 EUR’,
‘<p style="margin:0 0 8px;font-size:11px;color:#22C55E;font-weight:700">OPORTUNIDAD GANADA</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Cliente:</b> GUILLEN JAMONES</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Valor:</b> <span style="color:#22C55E;font-weight:700">8.500 EUR</span></p>’
+ ‘<p style="margin:0;font-size:12px;color:#64748B">Azarco ha cerrado esta oportunidad con exito.</p>’
);

// 13. OPORTUNIDAD PERDIDA → notifica al jefe con motivo
await enviar(‘AZARCO (Comercial)’, ‘13. Oportunidad PERDIDA con motivo’,
‘Oportunidad perdida: CARNAVI S.L. — Motivo: Precio’,
‘<p style="margin:0 0 8px;font-size:11px;color:#DC2626;font-weight:700">OPORTUNIDAD PERDIDA</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Cliente:</b> CARNAVI S.L.</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Valor:</b> 3.200 EUR</p>’
+ ‘<p style="margin:0 0 8px;font-size:13px;color:#DC2626"><b>Motivo:</b> Precio — competencia ofrece 12.50 EUR/kg vs 14.14 EUR/kg</p>’
);

// 14. HITO completado → notifica al creador
await enviar(‘AZARCO (Comercial)’, ‘14. Hito completado en proyecto’,
‘Hito completado: Prueba en linea — Proyecto CASALBA’,
‘<p style="margin:0 0 8px;font-size:11px;color:#22C55E;font-weight:700">HITO COMPLETADO</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Proyecto:</b> Prueba industrial CASALBA</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Hito:</b> Prueba en linea de produccion</p>’
+ ‘<p style="margin:0;font-size:12px;color:#64748B">Azarco ha completado este hito.</p>’
);

// 15. PROYECTO cerrado sin exito
await enviar(‘JEFE VENTAS (Director)’, ‘15. Proyecto cerrado SIN EXITO’,
‘Proyecto cerrado sin exito: CASALBA — Prueba industrial fallida’,
‘<p style="margin:0 0 8px;font-size:11px;color:#DC2626;font-weight:700">PROYECTO SIN EXITO</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Proyecto:</b> Prueba industrial CASALBA</p>’
+ ‘<p style="margin:0 0 8px;font-size:13px;color:#DC2626"><b>Motivo:</b> Prueba industrial fallida</p>’
+ ‘<p style="margin:0;font-size:12px;color:#64748B;font-style:italic">“La tripa no resiste ahumado a 85 grados durante 4h”</p>’
);

// 16. TAREA completada → notifica al creador
await enviar(‘AZARCO (Comercial)’, ‘16. Tarea completada’,
‘Tarea completada: Visitar CHACINAS CASTILLO’,
‘<p style="margin:0 0 8px;font-size:11px;color:#22C55E;font-weight:700">TAREA COMPLETADA</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Tarea:</b> Visitar CHACINAS CASTILLO — entrega catalogo</p>’
+ ‘<p style="margin:0;font-size:12px;color:#64748B">Azarco ha completado la tarea.</p>’
);

// 17. ESTRATEGIA RECHAZADA
await enviar(‘RESP. INTERKEY (Jefe)’, ‘17. Estrategia RECHAZADA’,
‘Estrategia rechazada: CARNAVI S.L.’,
‘<p style="margin:0 0 8px;font-size:11px;color:#DC2626;font-weight:700">ESTRATEGIA RECHAZADA</p>’
+ ‘<p style="margin:0 0 4px;font-size:13px"><b>Cliente:</b> CARNAVI S.L.</p>’
+ ‘<p style="margin:0 0 8px;font-size:13px;color:#DC2626"><b>Motivo:</b> Descuento excesivo para el volumen. Proponer 5% maximo.</p>’
+ ‘<p style="margin:0;font-size:11px;color:#94A3B8">Rechazada por: Resp. INTERKEY</p>’
);

// RESULTADO
return res.status(200).json({
test: ‘CADENA COMPLETA DE NOTIFICACIONES’,
email_destino: testEmail,
total: results.length,
ok: ok,
fail: fail,
detalle: results,
});
};
