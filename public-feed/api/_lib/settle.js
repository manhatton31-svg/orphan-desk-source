/**
 * Settlement helpers for x402 Echo payments.
 * POST /api/settle_fee — RPC fail-closed via verifyAndConsume.
 */
const fs = require('fs');
const path = require('path');
const { verifyAndConsume, isHexTx, normalizeChain } = require('./verify_payment');
const { parsePaymentProof, feeAmount, RECEIVE } = require('./x402');
const { parseBody } = require('./negotiate');
const { feedbackMeta } = require('./feedback');
const { bumpFunnel } = require('./funnel');

let _echoIndex = null;

function echoRoots() {
  return [
    process.cwd(),
    path.join(process.cwd(), 'public-feed'),
    path.join(__dirname, '..', '..'),
    '/var/task',
  ];
}

function scanEchoFiles() {
  if (_echoIndex) return _echoIndex;
  const byId = new Map();
  const byFile = new Map();
  for (const root of echoRoots()) {
    let names;
    try {
      names = fs.readdirSync(root).filter((f) => f.endsWith('.echo.json'));
    } catch (_) {
      continue;
    }
    for (const name of names) {
      const fp = path.join(root, name);
      try {
        const echo = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (echo && echo.echo_id && !byId.has(echo.echo_id)) {
          byId.set(echo.echo_id, { echo, path: fp, file: name });
        }
        if (!byFile.has(name)) byFile.set(name, { echo, path: fp, file: name });
      } catch (_) {}
    }
  }
  _echoIndex = { byId, byFile };
  return _echoIndex;
}

function findEchoFile(echoId, fileName) {
  if (!echoId && !fileName) return null;
  const idx = scanEchoFiles();
  if (fileName) {
    const base = path.basename(String(fileName).replace(/^\//, ''));
    const hit = idx.byFile.get(base) || idx.byFile.get(base.endsWith('.echo.json') ? base : `${base}.echo.json`);
    if (hit) return hit;
  }
  if (echoId) {
    const hit = idx.byId.get(echoId);
    if (hit) return hit;
    for (const v of idx.byId.values()) {
      if (v.echo.order_uid === echoId || v.file === echoId || v.file === `${echoId}.echo.json`) return v;
    }
  }
  return null;
}

function json(res, status, body, extraHeaders) {
  res.statusCode = status;
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Accept, X-PAYMENT, X-PAYMENT-TX, X-PAYMENT-CHAIN, X-PAYMENT-ASSET, X-PAYMENT-AMOUNT, X-PAYMENT-PAYER, X-QUOTE-ID, X-BOND-WAIVER, X-CREDIT-TOKEN, PAYMENT-TX, PAYMENT-CHAIN',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(extraHeaders || {}),
  };
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

function receiptFor(echoId, v, quoteId) {
  return {
    receipt_id: `rcpt_${Date.now().toString(36)}_${(v.tx_hash || '').slice(2, 10)}`,
    echo_id: echoId,
    status: 'filled',
    quote_id: quoteId || undefined,
    fee: {
      collected_usd: v.amount,
      asset: v.asset,
      chain: v.chain,
      tx_hash: v.tx_hash,
      receive_address: v.to || RECEIVE,
      from: v.from,
    },
    example: false,
  };
}

async function settleFromPayment({ echoId, req, txHash, chain, amountUsdc, asset, payer, quoteId }) {
  const v = await verifyAndConsume(
    {
      tx_hash: txHash,
      chain,
      asset,
      expected_amount: amountUsdc,
      pay_to: RECEIVE,
    },
    { purpose: 'echo_settle', echo_id: echoId, quote_id: quoteId, payer }
  );
  if (!v.ok) {
    const http =
      v.error === 'tx_already_consumed'
        ? 409
        : v.error && String(v.error).startsWith('rpc_unavailable')
          ? 503
          : 400;
    return {
      ok: false,
      http,
      body: {
        ok: false,
        status: 'reject',
        reason: v.error,
        detail: v.detail,
        chain: v.chain || chain,
        skill: 'settle_fee',
        fail_closed: true,
        note: 'On-chain RPC verification failed — pay USDC (Base) or USDT (BSC) to fee wallet and retry with a real tx_hash. Fail-closed: no unlock/credits.',
        verify: {
          ok: false,
          error: v.error,
          rpc_hint:
            'Set RPC_BASE / RPC_BSC / RPC_ETHEREUM for dedicated endpoints; defaults to public RPCs with 3 retries.',
        },
      },
    };
  }
  const found = findEchoFile(echoId, null);
  const echo = found && found.echo;
  const receipt = receiptFor(echoId, v, quoteId);
  return {
    ok: true,
    body: {
      status: 'settled',
      echo_id: echoId,
      asset: v.asset,
      chain: v.chain,
      fees_collected_usd: v.amount,
      receive_address: v.to || RECEIVE,
      echo: echo || undefined,
      receipt,
      example: false,
    },
  };
}

async function handleSettleFee(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method !== 'POST') {
    return json(res, 405, {
      status: 'reject',
      reason: 'method_not_allowed',
      note: 'POST JSON {quote_id|echo_id, tx_hash, chain, amount_usdc|amount, asset?: USDC|USDT, payer?}',
      skill: 'settle_fee',
    });
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    return json(res, 400, { status: 'reject', reason: 'invalid_json', note: String(e.message || e), skill: 'settle_fee' });
  }

  const host = (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || 'dualregistry.dev';
  const proto = ((req.headers && req.headers['x-forwarded-proto']) || 'https').split(',')[0].trim();
  const url = new URL(req.url, `${proto}://${host}`);
  let payment = parsePaymentProof(req, url);
  if (!payment && body && body.tx_hash) {
    payment = {
      tx_hash: body.tx_hash,
      chain: body.chain || body.network || 'base',
      asset: (body.asset || 'USDC').toUpperCase(),
      amount: body.amount_usdc || body.amount || null,
      payer: body.payer || null,
    };
  }
  if (!payment || !isHexTx(payment.tx_hash)) {
    return json(res, 400, {
      status: 'reject',
      reason: 'invalid_tx_hash',
      note: 'tx_hash must be 0x-prefixed 32-byte hex',
      skill: 'settle_fee',
    });
  }

  const echoId = (body && (body.echo_id || body.echoId)) || url.searchParams.get('echo_id') || null;
  const quoteId = (body && (body.quote_id || body.quoteId)) || url.searchParams.get('quote_id') || null;
  if (!echoId && !quoteId) {
    return json(res, 400, {
      status: 'reject',
      reason: 'missing_echo_id',
      note: 'Pass echo_id or quote_id with tx_hash + chain',
      skill: 'settle_fee',
    });
  }

  const found = echoId ? findEchoFile(echoId, body && body.file) : null;
  const echo = found && found.echo;
  const amount = payment.amount || (echo && feeAmount(echo)) || (body && (body.amount_usdc || body.amount)) || '0.25';
  const chain = normalizeChain(payment.chain) || String(payment.chain || 'base').toLowerCase();

  const settled = await settleFromPayment({
    echoId: echoId || (echo && echo.echo_id),
    req,
    txHash: payment.tx_hash,
    chain,
    amountUsdc: amount,
    asset: payment.asset,
    payer: payment.payer || (body && body.payer),
    quoteId: quoteId || undefined,
  });
  if (!settled.ok) {
    return json(res, settled.http || 400, { ...settled.body, ...feedbackMeta(req) });
  }

  bumpFunnel({ settles: 1 });
  return json(res, 200, {
    ...settled.body,
    skill: 'settle_fee',
    ...feedbackMeta(req),
  });
}

module.exports = { findEchoFile, settleFromPayment, handleSettleFee, json };
