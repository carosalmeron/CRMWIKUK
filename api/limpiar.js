var https = require('https');

function markDeleted(id) {
  return new Promise(function(resolve) {
    var body = JSON.stringify({
      fields: {
        eliminada: { booleanValue: true },
        cliente: { stringValue: "BORRADO" }
      }
    });
    var req = https.request({
      hostname: 'firestore.googleapis.com',
      path: '/v1/projects/grupo-consolidado-crm/databases/(default)/documents/estrategias/' + id + '?updateMask.fieldPaths=eliminada&updateMask.fieldPaths=cliente',
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, function(resp) {
      var d = '';
      resp.on('data', function(c) { d += c; });
      resp.on('end', function() { resolve(resp.statusCode); });
    });
    req.on('error', function() { resolve(0); });
    req.write(body);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  try {
    var ids = ['est_1777013435427','est_1777138817419','est_1777152088639','est_1777499897377','est_1777582183015','est_jl_U439277'];
    var results = [];
    for (var i = 0; i < ids.length; i++) {
      var code = await markDeleted(ids[i]);
      results.push({ id: ids[i], status: code });
    }
    return res.status(200).json({ ok: true, results: results });
  } catch(err) {
    return res.status(200).json({ error: err.message });
  }
};
