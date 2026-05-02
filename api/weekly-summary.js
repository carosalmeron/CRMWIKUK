// /api/weekly-summary.js
// Cron: viernes 17:00 UTC (19:00 CEST / 18:00 CET)
// Envía un email combinado a cada agente y manager con:
//   1) Resumen del viernes (actividad del día en curso)
//   2) Resumen semanal completo (lunes a viernes)

const FB_BASE = "https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents";

function fsToObj(doc) {
  if (!doc || !doc.fields) return null;
  const out = {};
  for (const k in doc.fields) {
    const v = doc.fields[k];
    if (v.stringValue !== undefined) out[k] = v.stringValue;
    else if (v.integerValue !== undefined) out[k] = parseInt(v.integerValue);
    else if (v.doubleValue !== undefined) out[k] = parseFloat(v.doubleValue);
    else if (v.booleanValue !== undefined) out[k] = v.booleanValue;
    else if (v.timestampValue !== undefined) out[k] = v.timestampValue;
    else if (v.nullValue !== undefined) out[k] = null;
    else if (v.arrayValue && v.arrayValue.values) {
      out[k] = v.arrayValue.values.map(x => {
        if (x.stringValue !== undefined) return x.stringValue;
        if (x.integerValue !== undefined) return parseInt(x.integerValue);
        if (x.mapValue) return fsToObj({ fields: x.mapValue.fields });
        return x;
      });
    } else if (v.mapValue) {
      out[k] = fsToObj({ fields: v.mapValue.fields });
    }
  }
  return out;
}

async function fbList(coleccion) {
  const url = `${FB_BASE}/${coleccion}?pageSize=1000`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  if (!json.documents) return [];
  return json.documents.map(d => {
    const id = d.name.split("/").pop();
    return { id, ...fsToObj(d) };
  });
}

function getSemanaISO(d = new Date()) {
  const target = new Date(d.valueOf());
  const dayNr = (d.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay()) + 7) % 7);
  }
  return 1 + Math.ceil((firstThursday - target) / 604800000);
}

function rangeWeekDates() {
  const hoy = new Date();
  const offset = (hoy.getDay() || 7) - 1;
  const lunes = new Date(hoy); lunes.setDate(hoy.getDate() - offset); lunes.setHours(0, 0, 0, 0);
  const viernes = new Date(lunes); viernes.setDate(lunes.getDate() + 4); viernes.setHours(23, 59, 59, 999);
  return { lunes, viernes };
}

function rangeViernes() {
  const hoy = new Date();
  const offset = (hoy.getDay() || 7) - 1;
  const lunes = new Date(hoy); lunes.setDate(hoy.getDate() - offset); lunes.setHours(0, 0, 0, 0);
  const ini = new Date(lunes); ini.setDate(lunes.getDate() + 4); ini.setHours(0, 0, 0, 0);
  const fin = new Date(ini); fin.setHours(23, 59, 59, 999);
  return { ini, fin };
}

function fmtNum(n) {
  return new Intl.NumberFormat("es-ES", { minimumFractionDigits: 0 }).format(n || 0);
}

function parseFecha(f) {
  if (!f) return null;
  let d = null;
  if (typeof f === "string" && f.includes("/")) {
    const p = f.split("/");
    if (p.length === 3) {
      let yy = parseInt(p[2]); if (yy < 100) yy += 2000;
      d = new Date(yy, parseInt(p[1]) - 1, parseInt(p[0]));
    }
  } else if (typeof f === "string") d = new Date(f);
  else if (typeof f === "number") d = new Date(f);
  return d && !isNaN(d.getTime()) ? d : null;
}

function itemEnSemana(item, semana, lunes, viernes) {
  if (item.semana !== undefined && item.semana !== null && item.semana !== "") {
    const s = parseInt(item.semana);
    if (!isNaN(s)) return s === semana;
  }
  for (const k of ["fecha", "fechaCreacion", "creadoEn"]) {
    const d = parseFecha(item[k]);
    if (d && d >= lunes && d <= viernes) return true;
  }
  return false;
}

function itemEnDia(item, ini, fin) {
  for (const k of ["fecha", "fechaCreacion", "creadoEn"]) {
    const d = parseFecha(item[k]);
    if (d && d >= ini && d <= fin) return true;
  }
  return false;
}

function pertenece(item, ids) {
  const ag = String(item.agente || item.agenteId || item.autor || item.creadoPor || "").toUpperCase();
  return ids.has(ag);
}

function buildHTML({ titulo, agenteNombre, semana, lunes, viernes, dia, viernesData, semanaData, byTeamSemana, byTeamViernes }) {
  const fmtDate = d => d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" });

  const kpiCard = (n, label, color) => `
    <div style="flex:1;min-width:90px;background:${color}15;border-radius:10px;padding:12px;text-align:center">
      <p style="margin:0;font-size:22px;font-weight:800;color:${color}">${n}</p>
      <p style="margin:0;font-size:11px;color:#64748B">${label}</p>
    </div>`;

  const renderKpis = data => `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
      ${kpiCard(data.visitas.length, "Visitas", "#22C55E")}
      ${kpiCard(data.ops.length, "Oportunidades", "#1E3A5F")}
      ${kpiCard(data.est.length, "Estrategias", "#7C3AED")}
      ${kpiCard(data.inc.length, "Incidencias", "#EF4444")}
      ${kpiCard(data.mue.length, "Muestras", "#F59700")}
    </div>`;

  const valorPipelineSem = semanaData.ops.reduce((s, o) => s + (parseFloat(o.valor) || 0), 0);
  const valorPipelineVie = viernesData.ops.reduce((s, o) => s + (parseFloat(o.valor) || 0), 0);

  const renderByTeam = (byTeam, label) => {
    if (!byTeam) return "";
    let out = `<p style="margin:14px 0 6px;font-size:13px;font-weight:700;color:#1E3A5F">${label}</p>`;
    for (const team of Object.keys(byTeam)) {
      const t = byTeam[team];
      out += `
        <div style="background:#F8FAFC;border-radius:8px;padding:10px 12px;margin-bottom:6px">
          <p style="margin:0;font-weight:700;color:#1E3A5F;font-size:13px">${team}</p>
          <p style="margin:2px 0 0;font-size:12px;color:#475569">
            ${t.visitas} visitas · ${t.ops} ops · ${t.est} estrat. · ${t.inc} incid. · ${t.mue} muestras
          </p>
        </div>`;
    }
    return out;
  };

  const renderListaVisitas = (vs, max = 10) => vs.length === 0 ? "" : `
    <ul style="padding-left:20px;font-size:13px;line-height:1.7;margin:6px 0 16px">
      ${vs.slice(0, max).map(v => `<li>${v.clienteNombre || v.cliente || "—"}${v.fecha ? ` <span style="color:#64748B">(${v.fecha})</span>` : ""}</li>`).join("")}
      ${vs.length > max ? `<li style="list-style:none;color:#64748B">... y ${vs.length - max} más</li>` : ""}
    </ul>`;

  const renderListaOps = (os, max = 8) => os.length === 0 ? "" : `
    <ul style="padding-left:20px;font-size:13px;line-height:1.7;margin:6px 0 16px">
      ${os.slice(0, max).map(o => `<li>${o.cliente || o.nombre || "—"} — <b>${fmtNum(o.valor || 0)}€</b></li>`).join("")}
      ${os.length > max ? `<li style="list-style:none;color:#64748B">... y ${os.length - max} más</li>` : ""}
    </ul>`;

  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#F8FAFC;padding:20px;color:#0F172A">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06)">

    <div style="background:linear-gradient(135deg,#1E3A5F,#3B82F6);color:#fff;padding:24px 20px">
      <p style="margin:0;font-size:13px;opacity:.85">📅 Cierre de semana · Semana ${semana}</p>
      <h1 style="margin:6px 0 0;font-size:24px">${titulo}</h1>
      <p style="margin:6px 0 0;font-size:13px;opacity:.85">${fmtDate(lunes)} → ${fmtDate(viernes)}</p>
    </div>

    <div style="padding:24px 20px">
      ${agenteNombre ? `<p style="margin:0 0 16px;font-size:15px">Hola <b>${agenteNombre}</b>, aquí va tu cierre de semana:</p>` : `<p style="margin:0 0 16px;font-size:15px">Resumen consolidado:</p>`}

      <div style="border-left:4px solid #3B82F6;padding-left:14px;margin-bottom:24px">
        <h2 style="color:#3B82F6;margin:0 0 4px;font-size:18px">🗓️ Hoy ${fmtDate(dia)}</h2>
        <p style="margin:0 0 12px;font-size:13px;color:#64748B">Actividad del viernes · Pipeline ${fmtNum(valorPipelineVie)}€</p>
        ${renderKpis(viernesData)}
        ${renderByTeam(byTeamViernes, "Por equipo (viernes)")}
        ${viernesData.visitas.length > 0 ? `<p style="margin:14px 0 4px;font-size:12px;font-weight:700;color:#475569">Visitas del día</p>${renderListaVisitas(viernesData.visitas, 6)}` : ""}
      </div>

      <div style="border-left:4px solid #1E3A5F;padding-left:14px">
        <h2 style="color:#1E3A5F;margin:0 0 4px;font-size:18px">📊 Semana completa</h2>
        <p style="margin:0 0 12px;font-size:13px;color:#64748B">${fmtDate(lunes)} → ${fmtDate(viernes)} · Pipeline ${fmtNum(valorPipelineSem)}€</p>
        ${renderKpis(semanaData)}
        ${renderByTeam(byTeamSemana, "Por equipo (semana)")}
        ${semanaData.visitas.length > 0 ? `<p style="margin:14px 0 4px;font-size:12px;font-weight:700;color:#475569">Visitas (top ${Math.min(semanaData.visitas.length, 10)} de ${semanaData.visitas.length})</p>${renderListaVisitas(semanaData.visitas, 10)}` : ""}
        ${semanaData.ops.length > 0 ? `<p style="margin:14px 0 4px;font-size:12px;font-weight:700;color:#475569">Oportunidades activas</p>${renderListaOps(semanaData.ops, 8)}` : ""}
      </div>

      <p style="margin:24px 0 0;text-align:center">
        <a href="https://crmwikuk.vercel.app" style="display:inline-block;background:#1E3A5F;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">Abrir CRM</a>
      </p>

      <p style="margin:24px 0 0;font-size:11px;color:#94A3B8;text-align:center">Grupo Consolidado · Informe automático ${new Date().toLocaleString("es-ES")}</p>
    </div>
  </div>
  </body></html>`;
}

export default async function handler(req, res) {
  const isManual = req.query && req.query.manual === "1";
  const isCron = req.headers["user-agent"] && req.headers["user-agent"].includes("vercel-cron");
  if (!isManual && !isCron) {
    return res.status(401).json({ ok: false, error: "Solo via cron o ?manual=1" });
  }

  try {
    const semana = getSemanaISO();
    const { lunes, viernes } = rangeWeekDates();
    const viernesRange = rangeViernes();

    const [usuarios, visitas, oportunidades, estrategias, incidencias, muestras] = await Promise.all([
      fbList("usuarios"),
      fbList("visitas"),
      fbList("oportunidades"),
      fbList("estrategias"),
      fbList("incidencias"),
      fbList("muestras"),
    ]);

    const inWeek = arr => arr.filter(x => !x.eliminada && itemEnSemana(x, semana, lunes, viernes));
    const visSem = inWeek(visitas);
    const opsSem = inWeek(oportunidades);
    const estSem = inWeek(estrategias);
    const incSem = inWeek(incidencias);
    const mueSem = inWeek(muestras);

    const onlyFriday = arr => arr.filter(x => itemEnDia(x, viernesRange.ini, viernesRange.fin));
    const visVie = onlyFriday(visSem);
    const opsVie = onlyFriday(opsSem);
    const estVie = onlyFriday(estSem);
    const incVie = onlyFriday(incSem);
    const mueVie = onlyFriday(mueSem);

    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const sent = [];
    const errors = [];

    const dataPorIds = (ids) => ({
      semanaData: {
        visitas: visSem.filter(x => pertenece(x, ids)),
        ops:     opsSem.filter(x => pertenece(x, ids)),
        est:     estSem.filter(x => pertenece(x, ids)),
        inc:     incSem.filter(x => pertenece(x, ids)),
        mue:     mueSem.filter(x => pertenece(x, ids)),
      },
      viernesData: {
        visitas: visVie.filter(x => pertenece(x, ids)),
        ops:     opsVie.filter(x => pertenece(x, ids)),
        est:     estVie.filter(x => pertenece(x, ids)),
        inc:     incVie.filter(x => pertenece(x, ids)),
        mue:     mueVie.filter(x => pertenece(x, ids)),
      },
    });

    const agentes = usuarios.filter(u => (u.rol === "agente" || u.rol === "crm_agente") && u.email);
    for (const ag of agentes) {
      const ids = new Set();
      ["id", "grupoAgente", "nombre", "username"].forEach(k => { if (ag[k]) ids.add(String(ag[k]).toUpperCase()); });
      const { semanaData, viernesData } = dataPorIds(ids);

      const html = buildHTML({
        titulo: "Tu cierre de semana",
        agenteNombre: ag.nombre,
        semana, lunes, viernes,
        dia: viernesRange.ini,
        viernesData, semanaData,
      });

      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: ag.email,
          subject: `📊 Cierre semana ${semana} + viernes`,
          html,
        });
        sent.push({ tipo: "agente", email: ag.email });
      } catch (err) {
        errors.push({ tipo: "agente", email: ag.email, error: err.message });
      }
    }

    const managers = usuarios.filter(u => ["jefe", "director", "ceo"].includes(u.rol) && u.email);
    for (const mg of managers) {
      let semanaData, viernesData, byTeamSemana = null, byTeamViernes = null;

      if (mg.rol === "jefe") {
        const idsEquipo = new Set();
        usuarios.filter(u => (u.rol === "agente" || u.rol === "crm_agente") && u.equipo === mg.equipo).forEach(u => {
          ["id", "grupoAgente", "nombre", "username"].forEach(k => { if (u[k]) idsEquipo.add(String(u[k]).toUpperCase()); });
        });
        const d = dataPorIds(idsEquipo);
        semanaData = d.semanaData; viernesData = d.viernesData;
      } else {
        semanaData = { visitas: visSem, ops: opsSem, est: estSem, inc: incSem, mue: mueSem };
        viernesData = { visitas: visVie, ops: opsVie, est: estVie, inc: incVie, mue: mueVie };
        byTeamSemana = {};
        byTeamViernes = {};
        for (const team of ["WIKUK", "INTERKEY"]) {
          const idsT = new Set();
          usuarios.filter(u => (u.rol === "agente" || u.rol === "crm_agente") && u.equipo === team).forEach(u => {
            ["id", "grupoAgente", "nombre", "username"].forEach(k => { if (u[k]) idsT.add(String(u[k]).toUpperCase()); });
          });
          byTeamSemana[team] = {
            visitas: visSem.filter(x => pertenece(x, idsT)).length,
            ops:     opsSem.filter(x => pertenece(x, idsT)).length,
            est:     estSem.filter(x => pertenece(x, idsT)).length,
            inc:     incSem.filter(x => pertenece(x, idsT)).length,
            mue:     mueSem.filter(x => pertenece(x, idsT)).length,
          };
          byTeamViernes[team] = {
            visitas: visVie.filter(x => pertenece(x, idsT)).length,
            ops:     opsVie.filter(x => pertenece(x, idsT)).length,
            est:     estVie.filter(x => pertenece(x, idsT)).length,
            inc:     incVie.filter(x => pertenece(x, idsT)).length,
            mue:     mueVie.filter(x => pertenece(x, idsT)).length,
          };
        }
      }

      const html = buildHTML({
        titulo: mg.rol === "jefe" ? `Equipo ${mg.equipo} · cierre de semana` : "Cierre semanal consolidado",
        agenteNombre: mg.nombre,
        semana, lunes, viernes,
        dia: viernesRange.ini,
        viernesData, semanaData,
        byTeamSemana, byTeamViernes,
      });

      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: mg.email,
          subject: `📊 Cierre consolidado semana ${semana} + viernes`,
          html,
        });
        sent.push({ tipo: mg.rol, email: mg.email });
      } catch (err) {
        errors.push({ tipo: mg.rol, email: mg.email, error: err.message });
      }
    }

    return res.status(200).json({
      ok: true,
      semana,
      rango: { lunes: lunes.toISOString(), viernes: viernes.toISOString() },
      totales: {
        semana:  { visitas: visSem.length, ops: opsSem.length, est: estSem.length, inc: incSem.length, mue: mueSem.length },
        viernes: { visitas: visVie.length, ops: opsVie.length, est: estVie.length, inc: incVie.length, mue: mueVie.length },
      },
      sent,
      errors,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, stack: err.stack });
  }
}
