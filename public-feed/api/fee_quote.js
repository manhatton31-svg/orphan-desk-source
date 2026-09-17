const { handleFeeQuote } = require('./_lib/negotiate');

/**
 * Combined endpoint: POST { action?: "quote_fee"|"counter_fee", echo_id, bid_bps, ... }
 * Prefer dedicated /api/quote_fee and /api/counter_fee.
 */
module.exports = async function handler(req, res) {
  let skill = 'quote_fee';
  if (req.body && typeof req.body === 'object' && req.body.action === 'counter_fee') {
    skill = 'counter_fee';
  }
  return handleFeeQuote(req, res, skill);
};
