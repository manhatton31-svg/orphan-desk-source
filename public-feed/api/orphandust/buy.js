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
const { specAccepts, specHeaders, extractXPayment, pickAccept } = require('../_lib/x402_spec');
const { settleXPayment, decodePayment } = require('../_lib/x402_facilitator');

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
    const skuRow = getSku('od_unlock_050');
    const invoice = buildSkuInvoice(skuRow, req, { agent_id: null });
    const spend_on = spendOnForBuy();
    if (spend_on) invoice.spend_on = spend_on;
    const accepts = specAccepts({
      resource: `${baseUrl(req)}/api/orphandust/buy`,
      description: 'OrphanDust od_unlock_050 — unlock 1 named Echo',
      amountUsdc: skuRow.price_usdc,
    });
    return json(res, 402, invoice, {
      ...corsExtra(),
      ...specHeaders(accepts, skuRow.price_usdc),
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
    const xpay = extractXPayment(req) || (body && (body.x_payment || body.payment));
    if (xpay) {
      const resource = `${baseUrl(req)}/api/orphandust/buy`;
      const accepts = specAccepts({
        resource,
        description: `OrphanDust ${skuRow.sku} — ${skuRow.credits} named Echo unlock credit(s)`,
        amountUsdc: skuRow.price_usdc,
      });
      const settled = await settleXPayment(xpay, pickAccept(accepts, decodePayment(xpay)) || accepts[0]);
      if (!settled.ok) {
        return json(res, 402, {
          ok: false,
          reason: settled.error || 'x_payment_settle_failed',
          fail_closed: true,
          sku: skuRow.sku,
          note: 'X-PAYMENT facilitator settle failed. Pay USDC Transfer on Base and retry with X-PAYMENT-TX, or a valid X-PAYMENT for od_unlock_050.',
          skill: 'orphandust',
        }, { ...corsExtra(), ...specHeaders(accepts, skuRow.price_usdc) });
      }
      payment = {
        tx_hash: settled.tx_hash,
        chain: 'base',
        asset: 'USDC',
        amount: skuRow.price_usdc,
        payer: settled.payer || null,
        via: 'x402_facilitator',
        facilitator: settled.facilitator,
      };
    }
  }

  if (!payment) {
    const invoice = buildSkuInvoice(skuRow, req, { agent_id });
    const spend_on = spendOnForBuy();
    if (spend_on) invoice.spend_on = spend_on;
    const accepts = specAccepts({
      resource: `${baseUrl(req)}/api/orphandust/buy`,
      description: `OrphanDust ${skuRow.sku} — ${skuRow.credits} named Echo unlock credit(s)`,
      amountUsdc: skuRow.price_usdc,
    });
    return json(res, 402, invoice, {
      ...corsExtra(),
      ...specHeaders(accepts, skuRow.price_usdc),
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
