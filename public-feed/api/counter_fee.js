const { handleFeeQuote } = require('./_lib/negotiate');

/** Alias of quote_fee — same deterministic OBO rules; skill id counter_fee for agent cards. */
module.exports = async function handler(req, res) {
  return handleFeeQuote(req, res, 'counter_fee');
};
