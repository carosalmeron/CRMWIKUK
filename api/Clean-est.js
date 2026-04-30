var https = require(‘https’);
var FB = ‘https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents’;
function httpDel(u) {
return new Promise(function(r) {
var opts = require(‘url’).parse(u);
opts.method = ‘DELETE’;
var req = https.request(opts, function(s) {
var d = ‘’;
s.on(‘data’, function(c) { d += c; });
s.on(‘end’, function() { r(s.statusCode); });
});
req.on(‘error’, function() { r(0); });
req.end();
});
}
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
var code = await httpDel(FB + ‘/estrategias/’ + borrar[i]);
results.push({ id: borrar[i], status: code });
}
return res.status(200).json({ ok: true, deleted: results });
} catch(err) {
return res.status(200).json({ error: err.message });
}
};
