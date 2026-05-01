var https = require('https');
function markDel(id) {
  return new Promise(function(resolve) {
    var body = JSON.stringify({ fields: { eliminada: { booleanValue: true } } });
    var req = https.request({ hostname: 'firestore.googleapis.com', path: '/v1/projects/grupo-consolidado-crm/databases/(default)/documents/estrategias/' + id + '?updateMask.fieldPaths=eliminada', method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, function(resp) { resp.on('data', function() {}); resp.on('end', function() { resolve(resp.statusCode); }); });
    req.on('error', function() { resolve(0); }); req.write(body); req.end();
  });
}
module.exports = async function handler(req, res) {
  try {
    var ids = ['est_1777583786050','est_1777585172083','est_1777586034421','est_1777586300955','est_1777586858870','inc1777325256183'];
    var results = [];
    for (var i = 0; i < ids.length; i++) {
      var col = ids[i].startsWith('inc') ? 'incidencias' : 'estrategias';
      var body = JSON.stringify({ fields: { eliminada: { booleanValue: true } } });
      var code = await new Promise(function(resolve) {
        var req2 = https.request({ hostname: 'firestore.googleapis.com', path: '/v1/projects/grupo-consolidado-crm/databases/(default)/documents/' + col + '/' + ids[i] + '?updateMask.fieldPaths=eliminada', method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, function(resp) { resp.on('data', function() {}); resp.on('end', function() { resolve(resp.statusCode); }); });
        req2.on('error', function() { resolve(0); }); req2.write(body); req2.end();
      });
      results.push({ id: ids[i], status: code });
    }
    return res.status(200).json({ ok: true, cleaned: results });
  } catch(err) { return res.status(200).json({ error: err.message }); }
};
