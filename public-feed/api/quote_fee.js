const { handleFeeQuote } = require('./_lib/negotiate');

module.exports = async function handler(req, res) {
  return handleFeeQuote(req, res, 'quote_fee');
};
