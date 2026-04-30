var https = require(‘https’);

module.exports = async function handler(req, res) {
try {
var borrar = [
‘est_1777013435427’,
‘est_1777138817419’,
‘est_1777152088639’,
‘est_1777499897377’,
‘est_1777582183015’,
‘est_jl_U439277’
];
var results = [];
for (var i = 0; i < borrar.length; i++) {
var code = await new Promise(function(resolve) {
var req2 = https.request({
hostname: ‘firestore.googleapis.com’,
path: ‘/v1/projects/grupo-consolidado-crm/databases/(default)/documents/estrategias/’ + borrar[i],
method: ‘DELETE’
}, function(resp) {
resp.on(‘data’, function() {});
resp.on(‘end’, function() { resolve(resp.statusCode); });
});
req2.on(‘error’, function() { resolve(0); });
req2.end();
});
results.push({ id: borrar[i], status: code });
}
return res.status(200).json({ ok: true, deleted: results });
} catch(err) {
return res.status(200).json({ error: err.message });
}
};
