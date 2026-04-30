var https = require('https');
var FB = 'https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents';

function httpGet(u) {
  return new Promise(function(r) {
    https.get(u, function(s) {
      var d = '';
      s.on('data', function(c) { d += c; });
      s.on('end', function() { try { r(JSON.parse(d)); } catch(e) { r({}); } });
    }).on('error', function() { r({}); });
  });
}

function pv(v) {
  if (!v) return '';
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue);
  if (v.doubleValue !== undefined) return parseFloat(v.doubleValue);
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.arrayValue) return (v.arrayValue.values || []).map(pv);
  if (v.mapValue) { var o = {}; Object.entries(v.mapValue.fields || {}).forEach(function(e) { o[e[0]] = pv(e[1]); }); return o; }
  return '';
}

module.exports = async function handler(req, res) {
  try {
    var d = await httpGet(FB + '/estrategias?pageSize=500');
    var todas = (d.documents || []).map(function(doc) {
      var o = { id: doc.name.split('/').pop() };
      Object.entries(doc.fields || {}).forEach(function(e) { o[e[0]] = pv(e[1]); });
      return o;
    });

    var quinta = todas.filter(function(e) {
      var cli = (e.cliente || e.clienteNombre || '').toUpperCase();
      return cli.indexOf('QUINTA') >= 0 || cli.indexOf('JUGAIS') >= 0;
    });

    var eliminadas = todas.filter(function(e) { return e.eliminada; });

    return res.status(200).json({
      total: todas.length,
      eliminadas: eliminadas.length,
      quinta: quinta,
      todas: todas.map(function(e) {
        return {
          id: e.id,
          cliente: e.cliente || e.clienteNombre || '',
          estado: e.estado || '',
          eliminada: !!e.eliminada,
          agente: e.agente || ''
        };
      })
    });
  } catch(err) {
    return res.status(200).json({ error: err.message });
  }
};
