/**
 * Spec-shaped x402 accepts + PAYMENT-REQUIRED header.
 * Dual-list v1 `base` and CAIP-2 `eip155:8453` so routers that hold a Base
 * wallet (agent402 uses eip155:8453) can dispatch. Settlement still fail-closed.
 */
const RECEIVE = '0x459cF7359e37B45A0d2a2479656cD96cdA9F7dBb';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function usdcAtomic(amount) {
  const n = Math.round(parseFloat(amount) * 1e6);
  return Number.isFinite(n) && n > 0 ? String(n) : '500000';
}

function oneAccept({ resource, description, amountUsdc, network }) {
  return {
    scheme: 'exact',
    network,
    maxAmountRequired: usdcAtomic(amountUsdc),
    resource,
    description,
    mimeType: 'application/json',
    payTo: RECEIVE,
    maxTimeoutSeconds: 600,
    asset: USDC_BASE,
    extra: { name: 'USDC', version: '2', chainId: 8453, caip2: 'eip155:8453' },
  };
}

function specAccepts({ resource, description, amountUsdc }) {
  const args = { resource, description, amountUsdc };
  return [oneAccept({ ...args, network: 'eip155:8453' }), oneAccept({ ...args, network: 'base' })];
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
    'x402-network': 'eip155:8453',
    'x402-pay-to': RECEIVE,
  };
}

function extractXPayment(req) {
  const h = (req && req.headers) || {};
  const raw = h['x-payment'] || h['payment-signature'] || h['payment-required'] || null;
  if (!raw || raw === 'true') return null;
  return String(raw);
}

function pickAccept(accepts, paymentPayload) {
  const list = Array.isArray(accepts) ? accepts : [];
  const net =
    (paymentPayload && paymentPayload.network) ||
    (paymentPayload && paymentPayload.payload && paymentPayload.payload.network) ||
    null;
  if (net) {
    const hit = list.find((a) => a && a.network === net);
    if (hit) return hit;
  }
  return list[0] || null;
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
  pickAccept,
};
