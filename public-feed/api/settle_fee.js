const { handleSettleFee } = require('./_lib/settle');

module.exports = async function handler(req, res) {
  return handleSettleFee(req, res);
};
