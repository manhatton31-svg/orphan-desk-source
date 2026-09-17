/**
 * POST /api/orphandust/buy — {sku, agent_id?} → 402 invoice or credits after payment proof
 */
const {
  getSku,
  buildSkuInvoice,
  completePurchase,
  parsePaymentProof,
  amountsMatch,
  catalogBody,
  baseUrl,
  RECEIVE,
} = require('../_lib/orphandust');
const { feedbackMeta } = require('../_lib/feedback');
const { parseBody, json } = require('../_lib/negotiate');
const { verifyAndConsume, normalizeChain } = require('../_lib/verify_payment');
const { spendOnForBuy } = require('../_lib/fillable');

function corsExtra() {
  return {
    'Access-Control-Allow-Headers':
      'Content-Type, Accept, X-PAYMENT, X-PAYMENT-TX, X-PAYMENT-CHAIN, X-PAYMENT-ASSET, X-PAYMENT-AMOUNT, X-PAYMENT-PAYER, X-CREDIT-TOKEN, X-BOND-WAIVER, PAYMENT-TX, PAYMENT-CHAIN',
  };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return json(res, 204, {}, corsExtra());
  }
  if (req.method === 'GET') {
    return json(res, 200, {
      ...catalogBody(req),
      skill: 'orphandust',
      note: 'POST {sku, agent_id?} — unpaid → HTTP 402 SKU invoice; with X-PAYMENT-* → credit_token',
    });
  }
  if (req.method !== 'POST') {
    return json(res, 405, {
      ok: false,
      reason: 'method_not_allowed',
      note: 'POST JSON {sku, agent_id?} — payment proof via X-PAYMENT-* headers or body tx_hash/chain',
      skill: 'orphandust',
    });
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    return json(res, 400, { ok: false, reason: 'invalid_json', note: String(e.message || e) });
  }

  const skuRow = getSku(body.sku);
  if (!skuRow) {
    return json(res, 400, {
      ok: false,
      reason: 'unknown_sku',
      allowed: ['od_unlock_050', 'od_credits_1', 'od_credits_2', 'od_credits_3'],
      catalog: `${baseUrl(req)}/ORPHANDUST.json`,
      skill: 'orphandust',
    });
  }

  const agent_id = body.agent_id ? String(body.agent_id).slice(0, 128) : null;
  const ua = (req.headers && req.headers['user-agent']) || '';

  // Payment from headers or body
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'dualregistry.dev';
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const url = new URL(req.url, `${proto}://${host}`);
  let payment = parsePaymentProof(req, url);
  if (!payment && body.tx_hash) {
    payment = {
      tx_hash: body.tx_hash,
      chain: body.chain || body.network || 'base',
      asset: (body.asset || 'USDC').toUpperCase(),
      amount: body.amount || body.amount_usdc || skuRow.price_usdc,
      payer: body.payer || null,
    };
    if (!/^0x[0-9a-fA-F]{64}$/.test(payment.tx_hash)) payment = null;
  }

  if (!payment) {
    const invoice = buildSkuInvoice(skuRow, req, { agent_id });
    const spend_on = spendOnForBuy();
    if (spend_on) invoice.spend_on = spend_on;
    return json(res, 402, invoice, {
      ...corsExtra(),
      'PAYMENT-REQUIRED': 'true',
      'X-Payment-Required': 'true',
    });
  }

  const payAmt = payment.amount || skuRow.price_usdc;
  if (payment.amount && !amountsMatch(skuRow.price_usdc, payment.amount)) {
    return json(res, 400, {
      ok: false,
      reason: 'amount_mismatch',
      expected: skuRow.price_usdc,
      got: payment.amount,
      sku: skuRow.sku,
      skill: 'orphandust',
    });
  }

  // Fail-closed on-chain RPC verification before issuing credits
  const chainNorm = normalizeChain(payment.chain) || String(payment.chain || 'base').toLowerCase();
  const verified = await verifyAndConsume(
    {
      tx_hash: payment.tx_hash,
      chain: chainNorm,
      asset: payment.asset || 'USDC',
      expected_amount: skuRow.price_usdc,
      pay_to: RECEIVE,
    },
    {
      purpose: 'orphandust_buy',
      sku: skuRow.sku,
      agent_id: agent_id || undefined,
    }
  );
  if (!verified.ok) {
    const http =
      verified.error === 'tx_already_consumed'
        ? 409
        : verified.error && String(verified.error).startsWith('rpc_unavailable')
          ? 503
          : verified.error === 'tx_not_found' || verified.error === 'no_matching_transfer'
            ? 402
            : 400;
    return json(res, http, {
      ok: false,
      reason: verified.error || 'payment_verify_failed',
      detail: verified.detail || undefined,
      sku: skuRow.sku,
      expected: skuRow.price_usdc,
      chain: chainNorm,
      skill: 'orphandust',
      fail_closed: true,
      note:
        'On-chain RPC verification failed — pay USDC (Base) or USDT (BSC) to fee wallet and retry with a real tx_hash. Fail-closed: no credits issued.',
      verify: { ok: false, error: verified.error },
      ...feedbackMeta(req),
    });
  }

  const result = completePurchase({
    skuRow,
    agent_id,
    ua,
    payment: {
      ...payment,
      amount: payAmt,
      chain: verified.chain || chainNorm,
      asset: verified.asset || payment.asset,
      payer: verified.from || payment.payer,
      on_chain_verified: true,
      token: verified.token,
      verify_rpc: verified.rpc,
      idempotency: verified.idempotency || undefined,
    },
  });

  return json(res, 200, {
    ...result,
    on_chain_verified: true,
    verify: {
      ok: true,
      chain: verified.chain,
      asset: verified.asset,
      amount: verified.amount,
      from: verified.from,
      to: verified.to,
      token: verified.token,
      rpc: verified.rpc,
    },
    skill: 'orphandust',
    ...feedbackMeta(req),
  });
};
