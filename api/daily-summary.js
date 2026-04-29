module.exports = async function handler(req, res) {
  return res.status(200).json({version:"v2-test", timestamp: new Date().toISOString()});
};
