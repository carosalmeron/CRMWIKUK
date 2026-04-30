module.exports = function handler(req, res) {
  try {
    var nm = require('nodemailer');
    return res.status(200).json({
      ok: true,
      nodemailer: typeof nm.createTransport === 'function' ? 'loaded' : 'broken',
      smtp_user: process.env.SMTP_USER ? 'set' : 'missing',
      smtp_pass: process.env.SMTP_PASS ? 'set' : 'missing',
      node: process.version
    });
  } catch (e) {
    return res.status(200).json({
      ok: false,
      error: e.message
    });
  }
};
