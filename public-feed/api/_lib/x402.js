/**
 * x402 machine invoice helpers for Orphan Desk Echo GET paywall.
 * Preferred: USDC on Base. Documented alt: USDT on BSC.
 * Receive: 0x459cF7359e37B45A0d2a2479656cD96cdA9F7dBb
 */

const RECEIVE = '0x459cF7359e37B45A0d2a2479656cD96cdA9F7dBb';
const { feedbackMeta } = require('./feedback');
const { cheaperUnlock } = require('./fillable');
const { specAccepts, specEnvelope } = require('./x402_spec');

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955';
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDT_ETH = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

function baseUrl(req) {
  const host = (req && (req.headers['x-forwarded-host'] || req.headers.host)) || 'dualregistry.dev';
  const proto = ((req && req.headers['x-forwarded-proto']) || 'https').split(',')[0].trim();
  return `${proto}://${host}`;
}

function feeAmount(echo) {
  const fee = (echo && echo.fee) || {};
  const x = (echo && echo.x402) || {};
  const amt =
    (fee.quoted_usdc != null && String(fee.quoted_usdc)) ||
    (x.amount != null && String(x.amount)) ||
    (fee.flat_usdc != null && String(fee.flat_usdc)) ||
    null;
  return amt;
}

function buildInvoice(echo, req) {
  const base = baseUrl(req);
  const amount = feeAmount(echo) || '0.25';
  const fee = (echo && echo.fee) || {};
  const echoId = echo.echo_id;
  const pathName =
    (echo.meta && echo.meta.echo_path) ||
    (echo._path) ||
    null;
  const payPath = pathName || `${echoId}.echo.json`;
  const dust = cheaperUnlock(echo, req, baseUrl);
  const dustAccepts = specAccepts({
    resource: `${base}/api/orphandust/buy`,
    description: 'OrphanDust od_unlock_050 — unlock 1 named Echo (preferred vs % fee)',
    amountUsdc: '0.50',
  });

  return {
    schema_version: '1.0.0',
    type: 'x402_payment_required',
    status: 402,
    x402Version: 1,
    echo_id: echoId,
    cheaper_unlock: dust,
    accepts: dustAccepts,
    order_uid: echo.order_uid || null,
    chain: echo.chain || null,
    amount: String(amount),
    amount_usdc: String(amount),
    receive_wallet: RECEIVE,
    pay_to: RECEIVE,
    preferred: {
      asset: 'USDC',
      network: 'base',
      chain_id: 8453,
      token: USDC_BASE,
      decimals: 6,
      pay_to: RECEIVE,
      amount: String(amount),
    },
    accepted: [
      {
        asset: 'USDC',
        network: 'base',
        chain_id: 8453,
        token: USDC_BASE,
        decimals: 6,
        pay_to: RECEIVE,
        amount: String(amount),
        preferred: true,
      },
      {
        asset: 'USDT',
        network: 'bsc',
        chain_id: 56,
        token: USDT_BSC,
        decimals: 18,
        pay_to: RECEIVE,
        amount: String(amount),
        note: 'USDT on BSC accepted at settle; USD-stable notional equals amount',
      },
      {
        asset: 'USDC',
        network: 'ethereum',
        chain_id: 1,
        token: USDC_ETH,
        decimals: 6,
        pay_to: RECEIVE,
        amount: String(amount),
      },
      {
        asset: 'USDT',
        network: 'ethereum',
        chain_id: 1,
        token: USDT_ETH,
        decimals: 6,
        pay_to: RECEIVE,
        amount: String(amount),
      },
    ],
    fee: {
      ask_bps: fee.ask_bps != null ? fee.ask_bps : fee.bps,
      floor_bps: fee.floor_bps,
      quoted_usdc: fee.quoted_usdc || amount,
      receive_address: fee.receive_address || RECEIVE,
      obo: !!fee.obo,
    },
    pay_urls: {
      echo_get: `${base}/${payPath}`,
      preview: `${base}/${payPath}?preview=1`,
      api_echo: `${base}/api/echo?echo_id=${encodeURIComponent(echoId)}`,
      redeem: `${base}/api/echo?echo_id=${encodeURIComponent(echoId)}`,
      settle_fee: `${base}/api/settle_fee`,
      quote_fee: `${base}/api/quote_fee`,
      counter_fee: `${base}/api/counter_fee`,
      feedback: `${base}/api/feedback`,
      orphandust: `${base}/ORPHANDUST.json`,
      orphandust_buy: `${base}/api/orphandust/buy`,
      orphandust_unlock: `${base}/api/orphandust/unlock`,
    },
    unlock: {
      retry_get_with:
        'After paying, retry GET with headers X-PAYMENT-TX (0x…), X-PAYMENT-CHAIN (base|bsc|ethereum), optional X-PAYMENT-ASSET (USDC|USDT), optional X-PAYMENT-AMOUNT. Or query ?tx_hash=&chain=&asset=&amount=. Server RPC-verifies Transfer to fee wallet (fail-closed) then auto settle_fee.',
      settle_fee_manual: `${base}/api/settle_fee`,
      note: 'POST /api/settle_fee remains for manual settle; both paths require on-chain RPC verification of USDC/USDT Transfer to fee wallet.',
    },
    ai_disclosure:
      'Scro Orphan Desk is an AI agent desk (Christopher Hatton). HTTP 402 invoice is machine-only; pay USDC (Base preferred) or USDT (BSC) to receive wallet. No human channel.',
    ...feedbackMeta(req),
  };
}

function redactPreview(echo, req) {
  const base = baseUrl(req);
  const fee = (echo && echo.fee) || {};
  const amount = feeAmount(echo);
  return {
    schema_version: echo.schema_version || '1.1.0',
    type: 'echo_preview',
    preview: true,
    echo_id: echo.echo_id,
    order_uid: echo.order_uid,
    chain: echo.chain,
    owner: echo.owner,
    pair: (echo.meta && echo.meta.pair) || null,
    notional_usd: echo.notional_usd,
    expired_at: echo.expired_at,
    why_died: echo.why_died,
    status: echo.status,
    fee: {
      ask_bps: fee.ask_bps != null ? fee.ask_bps : fee.bps,
      floor_bps: fee.floor_bps,
      quoted_usdc: fee.quoted_usdc || amount,
      receive_address: fee.receive_address || RECEIVE,
      obo: !!fee.obo,
      promo: fee.promo || undefined,
    },
    x402: echo.x402,
    fill_hint: echo.fill_hint
      ? {
          legs_locked: true,
          chain: echo.fill_hint.chain,
          order_uid: echo.fill_hint.order_uid,
          sell: echo.fill_hint.sell
            ? { symbol: echo.fill_hint.sell.symbol }
            : undefined,
          buy: echo.fill_hint.buy
            ? { symbol: echo.fill_hint.buy.symbol }
            : undefined,
          fee_quote: echo.fill_hint.fee_quote,
          pay_url: echo.fill_hint.pay_url,
          pay_402_url: echo.fill_hint.pay_402_url,
          preview_url: echo.fill_hint.preview_url,
          settle_fee_url: echo.fill_hint.settle_fee_url,
          quote_fee_url: echo.fill_hint.quote_fee_url,
          counter_fee_url: echo.fill_hint.counter_fee_url,
          note: 'Full sell/buy legs unlock after x402 payment',
        }
      : null,
    paywall: {
      full_echo: 'HTTP 402 unless paid — retry without preview=1 after payment, or GET /api/echo',
      invoice_hint: 'Omit preview=1 to receive HTTP 402 machine invoice',
    },
    stats_url: echo.stats_url || `${base}/stats.json`,
    agent_card_url: echo.agent_card_url || `${base}/.well-known/agent-card.json`,
    ai_disclosure: echo.ai_disclosure,
  };
}

/**
 * Parse payment proof from headers or query.
 * Accepts: X-PAYMENT-TX / PAYMENT-TX / x-payment-tx, X-PAYMENT-CHAIN, X-PAYMENT-ASSET, X-PAYMENT-AMOUNT, X-PAYMENT-PAYER
 * Or X-PAYMENT as JSON / colon-separated tx:chain:amount:asset
 * Or query tx_hash, chain, asset, amount, payer
 */
function parsePaymentProof(req, url) {
  const headers = (req && req.headers) || {};
  const q = url && url.searchParams ? url.searchParams : new URLSearchParams();
  const h = (name) => {
    const v = headers[name] || headers[name.toLowerCase()];
    return v != null ? String(v).trim() : null;
  };

  let tx = h('x-payment-tx') || h('payment-tx') || h('x-payment-tx-hash') || q.get('tx_hash') || q.get('tx');
  let chain = h('x-payment-chain') || h('payment-chain') || q.get('chain') || q.get('network');
  let asset = h('x-payment-asset') || h('payment-asset') || q.get('asset') || q.get('token');
  let amount = h('x-payment-amount') || h('payment-amount') || q.get('amount') || q.get('amount_usdc');
  let payer = h('x-payment-payer') || h('payment-payer') || q.get('payer');

  const rawPay = h('x-payment') || h('payment') || h('payment-signature');
  if (rawPay && !tx) {
    try {
      if (rawPay.startsWith('{')) {
        const j = JSON.parse(rawPay);
        tx = j.tx_hash || j.tx || j.hash || tx;
        chain = j.chain || j.network || chain;
        asset = j.asset || j.token || asset;
        amount = j.amount || j.amount_usdc || amount;
        payer = j.payer || j.from || payer;
      } else if (rawPay.includes(':')) {
        const parts = rawPay.split(':');
        tx = parts[0] || tx;
        chain = parts[1] || chain;
        amount = parts[2] || amount;
        asset = parts[3] || asset;
      } else if (/^0x[0-9a-fA-F]{64}$/.test(rawPay)) {
        tx = rawPay;
      }
    } catch (_) {
      /* ignore */
    }
  }

  if (!tx || !/^0x[0-9a-fA-F]{64}$/.test(tx)) return null;
  return {
    tx_hash: tx,
    chain: chain || 'base',
    asset: (asset || 'USDC').toUpperCase(),
    amount: amount || null,
    payer: payer || null,
  };
}

module.exports = {
  RECEIVE,
  USDC_BASE,
  USDT_BSC,
  buildInvoice,
  redactPreview,
  parsePaymentProof,
  feeAmount,
  baseUrl,
};
