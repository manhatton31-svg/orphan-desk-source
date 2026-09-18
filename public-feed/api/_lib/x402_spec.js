/**
 * Spec-shaped x402 v1 accepts + PAYMENT-REQUIRED header.
 * Lets bazaar/router crawlers learn Base USDC. Settlement still fail-closed
 * (X-PAYMENT-TX RPC verify, or facilitator settle then RPC verify).
 */
const RECEIVE = '0x459cF7359e37B45A0d2a2479656cD96cdA9F7dBb';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function usdcAtomic(amount) {
  const n = Math.round(parseFloat(amount) * 1e6);
  return Number.isFinite(n) && n > 0 ? String(n) : '500000';
}

function specAccepts({ resource, description, amountUsdc }) {
  const maxAmountRequired = usdcAtomic(amountUsdc);
  return [
    {
      scheme: 'exact',
      network: 'base',
      maxAmountRequired,
      resource,
      description,
      mimeType: 'application/json',
      payTo: RECEIVE,
      maxTimeoutSeconds: 600,
      asset: USDC_BASE,
      extra: { name: 'USDC', version: '2' },
    },
  ];
}

function specEnvelope(accepts) {
  return { x402Version: 1, accepts };
}

function paymentRequiredHeader(accepts) {
  return Buffer.from(JSON.stringify(specEnvelope(accepts))).toString('base64');
}

function specHeaders(accepts, amountUsdc) {
  return {
    'PAYMENT-REQUIRED': paymentRequiredHeader(accepts),
    'X-Payment-Required': 'true',
    'x402-price': String(amountUsdc),
    'x402-asset': 'USDC',
    'x402-network': 'base',
    'x402-pay-to': RECEIVE,
  };
}

function extractXPayment(req) {
  const h = (req && req.headers) || {};
  const raw = h['x-payment'] || h['payment-signature'] || h['payment-required'] || null;
  if (!raw || raw === 'true') return null;
  return String(raw);
}

module.exports = {
  RECEIVE,
  USDC_BASE,
  usdcAtomic,
  specAccepts,
  specEnvelope,
  paymentRequiredHeader,
  specHeaders,
  extractXPayment,
};
