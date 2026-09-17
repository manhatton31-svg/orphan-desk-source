/**
 * GET /api/echo — x402 paywall for individual Echo JSON.
 * After accept-402: pay then GET with X-PAYMENT-* (+ optional X-QUOTE-ID) to unlock legs.
 */
const fs = require('fs');
const path = require('path');
const {
  buildInvoice,
  redactPreview,
  parsePaymentProof,
  feeAmount,
  RECEIVE,
  baseUrl,
} = require('./_lib/x402');
const { settleFromPayment, findEchoFile } = require('./_lib/settle');
const { loadQuote, verifyQuoteForUnlock } = require('./_lib/negotiate');
const { bumpFunnel } = require('./_lib/funnel');
const { consumeCredit, extractCreditToken } = require('./_lib/orphandust');

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Accept, X-PAYMENT, X-PAYMENT-TX, X-PAYMENT-CHAIN, X-PAYMENT-ASSET, X-PAYMENT-AMOUNT, X-PAYMENT-PAYER, X-QUOTE-ID, X-CREDIT-TOKEN, PAYMENT-TX, PAYMENT-CHAIN',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
}

function send(res, status, body, extraHeaders) {
  const headers = { ...cors(), ...(extraHeaders || {}) };
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body, null, 2));
}

function tryLocalFile(name) {
  const roots = [
    process.cwd(),
    path.join(process.cwd(), 'public-feed'),
    path.join(process.cwd(), 'echo', 'feed'),
    '/var/task',
  ];
  const candidates = [];
  if (name) {
    const base = path.basename(String(name).replace(/^\//, ''));
    candidates.push(base.endsWith('.echo.json') ? base : `${base}.echo.json`);
  }
  for (const root of roots) {
    for (const c of candidates) {
      const fp = path.join(root, c);
      try {
        if (fs.existsSync(fp)) {
          return { echo: JSON.parse(fs.readFileSync(fp, 'utf8')), path: fp, file: path.basename(fp) };
        }
      } catch (_) {}
    }
  }
  return null;
}

async function fetchStaticEcho(req, fileOrId) {
  const base = baseUrl(req);
  const headers = {
    Accept: 'application/json',
    'x-od-internal': '1',
    'User-Agent': 'orphan-desk-api-echo/1.0',
  };

  let file = fileOrId;
  if (file && !String(file).endsWith('.echo.json')) {
    try {
      const idxRes = await fetch(`${base}/index.json`, { headers: { Accept: 'application/json' } });
      if (idxRes.ok) {
        const idx = await idxRes.json();
        const hit = (idx.echoes || []).find(
          (e) => e.echo_id === fileOrId || e.order_uid === fileOrId || e.path === fileOrId
        );
        if (hit && hit.path) file = hit.path;
      }
    } catch (_) {}
  }

  const paths = [];
  if (file && String(file).endsWith('.echo.json')) paths.push(String(file).replace(/^\//, ''));
  if (fileOrId && String(fileOrId).endsWith('.echo.json')) paths.push(String(fileOrId).replace(/^\//, ''));

  for (const p of paths) {
    try {
      const r = await fetch(`${base}/${p}`, { headers });
      if (r.ok) {
        const echo = await r.json();
        if (echo && echo.echo_id) return { echo, file: p, from: 'fetch' };
      }
    } catch (_) {}
  }
  return null;
}

async function loadEcho(req, { echoId, file }) {
  if (file) {
    const local = tryLocalFile(file);
    if (local) return local;
    const remote = await fetchStaticEcho(req, file);
    if (remote) return remote;
  }
  if (echoId) {
    const found = findEchoFile(echoId, null);
    if (found) return { echo: found.echo, path: found.path, file: path.basename(found.path) };
    const local = tryLocalFile(echoId);
    if (local) return local;
    const remote = await fetchStaticEcho(req, echoId);
    if (remote) return remote;
  }
  return null;
}

function parseQuoteId(req, url) {
  const headers = req.headers || {};
  const h = (name) => {
    const v = headers[name] || headers[name.toLowerCase()];
    return v != null ? String(v).trim() : null;
  };
  return (
    h('x-quote-id') ||
    h('quote-id') ||
    url.searchParams.get('quote_id') ||
    url.searchParams.get('quoteId') ||
    null
  );
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return send(res, 204, {});
  }
  if (req.method !== 'GET') {
    return send(res, 405, {
      status: 'reject',
      reason: 'method_not_allowed',
      note: 'GET /api/echo?echo_id=… — open Echoes require x402 payment (HTTP 402)',
    });
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host || 'dualregistry.dev';
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const url = new URL(req.url, `${proto}://${host}`);

  const echoId =
    url.searchParams.get('echo_id') ||
    url.searchParams.get('id') ||
    url.searchParams.get('echoId') ||
    null;
  const file =
    url.searchParams.get('file') ||
    url.searchParams.get('path') ||
    url.searchParams.get('echo_path') ||
    null;
  const preview =
    url.searchParams.get('preview') === '1' ||
    url.searchParams.get('mode') === 'preview';

  const loaded = await loadEcho(req, { echoId, file });
  if (!loaded) {
    return send(res, 404, {
      status: 'reject',
      reason: 'echo_not_found',
      echo_id: echoId,
      file,
      skill: 'redeem',
    });
  }

  const echo = loaded.echo;
  echo._path = loaded.file || file;

  if (echo.status && echo.status !== 'open') {
    return send(res, 200, echo);
  }

  if (preview) {
    return send(res, 200, redactPreview(echo, req));
  }

  // OrphanDust credit unlock (1 credit → full legs, no % fee)
  const creditToken = extractCreditToken(req, null, url);
  if (creditToken) {
    const spent = consumeCredit({
      credit_token: creditToken,
      agent_id: url.searchParams.get('agent_id') || null,
      ua: (req.headers && req.headers['user-agent']) || '',
      echo_id: echo.echo_id,
    });
    if (!spent.ok) {
      return send(res, 402, {
        status: 'reject',
        reason: spent.reason,
        echo_id: echo.echo_id,
        skill: 'orphandust',
        buy: `${baseUrl(req)}/api/orphandust/buy`,
        catalog: `${baseUrl(req)}/ORPHANDUST.json`,
        note: 'Invalid or exhausted credit_token — buy OrphanDust SKU or pay % fee via x402',
      });
    }
    return send(res, 200, {
      ...echo,
      status: echo.status || 'open',
      unlocked_via: 'orphandust_credit',
      credits_remaining: spent.credits_remaining,
      credit_token: spent.credit_token,
      balance_id: spent.balance_id,
      meta: {
        ...(echo.meta || {}),
        unlocked_via: 'orphandust_credit',
        orphandust_balance_id: spent.balance_id,
      },
      note: 'Full legs unlocked via OrphanDust credit (no % fee for this echo).',
    });
  }

  const quoteId = parseQuoteId(req, url);
  const payment = parsePaymentProof(req, url);

  if (payment) {
    let amount = payment.amount || feeAmount(echo) || '0.25';
    let quoteMeta = null;

    if (quoteId) {
      const quote = loadQuote(quoteId);
      const v = verifyQuoteForUnlock(quote, {
        echoId: echo.echo_id,
        amount: payment.amount || (quote && quote.final_usdc),
        asset: payment.asset,
      });
      if (!v.ok) {
        return send(res, 400, {
          status: 'reject',
          reason: v.reason,
          quote_id: quoteId,
          echo_id: echo.echo_id,
          expected: v.expected,
          got: v.got,
          note: 'quote_id must match echo, be unexpired, and amount/asset consistent with accepted quote',
          skill: 'redeem',
        });
      }
      quoteMeta = v.quote;
      if (quoteMeta.final_usdc) amount = String(quoteMeta.final_usdc);
    }

    const settled = await settleFromPayment({
      req,
      echoId: echo.echo_id,
      txHash: payment.tx_hash,
      chain: payment.chain,
      amountUsdc: amount,
      asset: payment.asset,
      payer: payment.payer,
      quoteId: quoteId || undefined,
    });
    if (!settled.ok) {
      return send(res, settled.http || 400, settled.body);
    }

    bumpFunnel({ settles: 1, accepts_without_settle: quoteMeta ? -1 : 0 });

    const unlocked = settled.body.echo || echo;
    return send(res, 200, {
      ...unlocked,
      status: unlocked.status || 'filled',
      quote_id: quoteId || undefined,
      payment_receipt: settled.body.receipt,
      settle: {
        status: settled.body.status,
        receipt_id: settled.body.receipt && settled.body.receipt.receipt_id,
        asset: settled.body.asset,
        fees_collected_usd: settled.body.fees_collected_usd,
        receive_address: RECEIVE,
        auto_settled_via: 'x402_get',
        quote_bound: !!quoteMeta,
      },
    });
  }

  // No payment proof — open Echo stays 402 (even if quote_id alone is presented)
  const invoice = buildInvoice(echo, req);
  invoice.orphandust = {
    catalog: `${baseUrl(req)}/ORPHANDUST.json`,
    buy: `${baseUrl(req)}/api/orphandust/buy`,
    unlock: `${baseUrl(req)}/api/orphandust/unlock`,
    flat_unlock_sku: 'od_unlock_050',
    flat_unlock_usdc: '0.50',
    note: 'Or buy OrphanDust micro-SKU credits to unlock without % fee (quote_bond_usdc=0).',
  };
  if (quoteId) {
    invoice.quote_id = quoteId;
    invoice.unlock = {
      ...(invoice.unlock || {}),
      note: 'quote_id alone does not unlock; pay then retry with X-PAYMENT-* + X-QUOTE-ID',
    };
  }
  return send(res, 402, invoice, {
    'PAYMENT-REQUIRED': 'true',
    'X-Payment-Required': 'true',
  });
};
