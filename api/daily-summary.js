var https = require(‘https’);
var FB = ‘https://firestore.googleapis.com/v1/projects/grupo-consolidado-crm/databases/(default)/documents’;

function httpGet(u) {
return new Promise(function(r) {
https.get(u, function(s) {
var d = ‘’;
s.on(‘data’, function(c) { d += c; });
s.on(‘end’, function() { try { r(JSON.parse(d)); } catch(e) { r({}); } });
}).on(‘error’, function() { r({}); });
});
}

module.exports = async function handler(req, res) {
try {
var t1 = Date.now();
var data = await Promise.all([
httpGet(FB + ‘/portal_users?pageSize=500’),
httpGet(FB + ‘/visitas?pageSize=500’)
]);
var t2 = Date.now();
var users = (data[0].documents || []).length;
var visitas = (data[1].documents || []).length;
return res.status(200).json({
ok: true,
step: ‘firebase_test’,
users: users,
visitas: visitas,
ms: t2 - t1
});
} catch(err) {
return res.status(200).json({ error: err.message });
}
};
