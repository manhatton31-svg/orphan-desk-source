/**
 * OrphanDust fixed-price unlock credits.
 * HMAC `odc_…` tokens + best-effort /tmp ledger (FEE_PATH.md).
 * Do not return credit_ledger_unavailable — HMAC verifies without shared state.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { feedbackMeta } = require('./feedback');

const RECEIVE = '0x459cF7359e37B45A0d2a2479656cD96cdA9F7dBb';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955';

const SKUS = {
  od_unlock_050: { price_usdc: '0.50', credits: 1, note: 'Flat single Echo unlock (freeze-breaker)' },
  od_credits_1: { price_usdc: '1.00', credits: 1, note: '1 unlock credit' },
  od_credits_2: { price_usdc: '3.00', credits: 2, note: '2 unlock credits' },
  od_credits_3: { price_usdc: '5.00', credits: 3, note: '3 unlock credits' },
};

const CREDIT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CREDIT_SECRET =
  process.env.ORPHAN_DESK_CREDIT_SECRET ||
  process.env.ORPHAN_DESK_SECRET ||
  'orphan-desk-credit-v1|0x459cF7359e37B45A0d2a2479656cD96cdA9F7dBb';

function baseUrl(req) {
  const h = (req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || 'dualregistry.dev';
  const proto = ((req && req.headers && req.headers['x-forwarded-proto']) || 'https').split(',')[0].trim();
  return `${proto}://${h}`;
}

function getSku(sku) {
  const x = SKUS[String(sku || '')];
  return x ? { ...x, sku: String(sku) } : null;
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function fromB64url(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64');
}

function signPayload(obj) {
  const payload = b64url(JSON.stringify(obj));
  const sig = b64url(crypto.createHmac('sha256', CREDIT_SECRET).update(payload).digest());
  return `odc_${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.startsWith('odc_')) return null;
  const raw = token.slice(4);
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expect = b64url(crypto.createHmac('sha256', CREDIT_SECRET).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(fromB64url(payload).toString('utf8'));
  } catch (_) {
    return null;
  }
}

function ledgerDirs() {
  return [
    '/tmp/orphan-desk-credits',
    path.join(process.cwd(), 'credits'),
    path.join(process.cwd(), 'public-feed', 'credits'),
  ];
}

function readJsonFile(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeLedger(name, record) {
  const wrote = [];
  for (const dir of ledgerDirs()) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const fp = path.join(dir, name);
      fs.writeFileSync(fp, JSON.stringify(record) + '\n');
      wrote.push(fp);
    } catch (_) {}
  }
  return wrote;
}

function loadLedger(name) {
  for (const dir of ledgerDirs()) {
    try {
      const fp = path.join(dir, name);
      if (fs.existsSync(fp)) {
        const obj = readJsonFile(fp);
        if (obj) return obj;
      }
    } catch (_) {}
  }
  return null;
}

function catalogBody(req) {
  const base = baseUrl(req);
  return {
    schema_version: '1.0.0',
    product: 'OrphanDust',
    desk: 'Scro Orphan Desk',
    audience: 'agents',
    ai_disclosure:
      'Scro OrphanDust is an AI agent micro-SKU (Christopher Hatton). Fixed unlock credits — agents only. No human channel. Pay USDC (Base preferred) or USDT (BSC) to fee wallet.',
    receive_wallet: RECEIVE,
    preferred: {
      asset: 'USDC',
      network: 'base',
      chain_id: 8453,
      token: USDC_BASE,
    },
    also_accepts: {
      asset: 'USDT',
      network: 'bsc',
      chain_id: 56,
      token: USDT_BSC,
    },
    quote_bond_usdc: 0,
    note: 'POST {sku, agent_id?} — unpaid → HTTP 402 SKU invoice; with X-PAYMENT-* → credit_token',
    skus: Object.entries(SKUS).map(([sku, x]) => ({ sku, price_usdc: x.price_usdc, credits: x.credits, note: x.note })),
    endpoints: {
      catalog: `${base}/ORPHANDUST.json`,
      product: `${base}/PRODUCT.json`,
      buy: `${base}/api/orphandust/buy`,
      unlock: `${base}/api/orphandust/unlock`,
      echo_with_credit: `${base}/api/echo?echo_id=…&credit_token=odc_…`,
    },
    skills: ['orphandust', 'buy_unlock'],
    catalog: `${base}/ORPHANDUST.json`,
    updated_at: new Date().toISOString(),
    ...feedbackMeta(req),
  };
}

function buildSkuInvoice(row, req, extra) {
  const base = baseUrl(req);
  const amount = String(row.price_usdc);
  return {
    schema_version: '1.0.0',
    type: 'x402_payment_required',
    product: 'OrphanDust',
    status: 402,
    http_status: 402,
    sku: row.sku,
    credits: row.credits,
    amount,
    amount_usdc: amount,
    price_usdc: amount,
    receive_wallet: RECEIVE,
    pay_to: RECEIVE,
    preferred: {
      asset: 'USDC',
      network: 'base',
      chain_id: 8453,
      token: USDC_BASE,
      decimals: 6,
      pay_to: RECEIVE,
      amount,
    },
    accepted: [
      {
        asset: 'USDC',
        network: 'base',
        chain_id: 8453,
        token: USDC_BASE,
        decimals: 6,
        pay_to: RECEIVE,
        amount,
        preferred: true,
      },
      {
        asset: 'USDT',
        network: 'bsc',
        chain_id: 56,
        token: USDT_BSC,
        decimals: 18,
        pay_to: RECEIVE,
        amount,
      },
    ],
    skill: 'orphandust',
    skills: ['orphandust', 'buy_unlock'],
    unlock_after_pay: {
      retry_post: `${base}/api/orphandust/buy`,
      body: { sku: row.sku, agent_id: extra && extra.agent_id ? extra.agent_id : undefined },
      headers: 'X-PAYMENT-TX + X-PAYMENT-CHAIN (+ optional X-PAYMENT-ASSET / X-PAYMENT-AMOUNT)',
    },
    note: `Pay ${amount} USDC (Base preferred) or USDT (BSC) for ${row.credits} unlock credit(s). Then retry POST with payment proof → credit_token.`,
    ai_disclosure:
      'Scro OrphanDust is an AI agent micro-SKU (Christopher Hatton). Fixed unlock credits — agents only. No human channel. Pay USDC (Base preferred) or USDT (BSC) to fee wallet.',
    ...feedbackMeta(req),
    ...(extra || {}),
  };
}

function parsePaymentProof(req, url) {
  const h = (req && req.headers) || {};
  const tx =
    h['x-payment-tx'] ||
    h['payment-tx'] ||
    (url && url.searchParams.get('tx_hash'));
  if (!tx || !/^0x[0-9a-fA-F]{64}$/.test(tx)) return null;
  return {
    tx_hash: tx,
    chain: h['x-payment-chain'] || (url && url.searchParams.get('chain')) || 'base',
    asset: (h['x-payment-asset'] || (url && url.searchParams.get('asset')) || 'USDC').toUpperCase(),
    amount: h['x-payment-amount'] || (url && url.searchParams.get('amount')),
  };
}

function amountsMatch(a, b) {
  return Math.abs(parseFloat(a) - parseFloat(b)) < 0.0001;
}

function mintToken({ skuRow, agent_id, credits, balance_id, payment }) {
  const now = Date.now();
  const jti = crypto.randomBytes(12).toString('hex');
  const bid = balance_id || `odb_${crypto.randomBytes(12).toString('hex')}`;
  const claims = {
    v: 1,
    bid,
    sku: skuRow.sku,
    cr: credits,
    exp: now + CREDIT_TTL_MS,
    iat: now,
    jti,
    ag: agent_id || null,
  };
  const credit_token = signPayload(claims);
  const record = {
    balance_id: bid,
    sku: skuRow.sku,
    credits_remaining: credits,
    credits_issued: skuRow.credits,
    agent_id: agent_id || null,
    jti,
    exp: new Date(claims.exp).toISOString(),
    iat: new Date(now).toISOString(),
    payment: payment || null,
  };
  writeLedger(`bal_${bid}.json`, record);
  writeLedger(`jti_${jti}.json`, { jti, balance_id: bid, status: 'active', credits_remaining: credits });
  return { credit_token, claims, record };
}

function completePurchase({ skuRow, agent_id, payment, ua }) {
  const minted = mintToken({
    skuRow,
    agent_id,
    credits: skuRow.credits,
    payment,
  });
  return {
    ok: true,
    sku: skuRow.sku,
    credits: skuRow.credits,
    credits_remaining: skuRow.credits,
    credit_token: minted.credit_token,
    balance_id: minted.record.balance_id,
    agent_id: agent_id || null,
    expires_at: minted.record.exp,
    payment: payment || undefined,
    receipt: {
      receipt_id: `odbuy_${minted.claims.jti}`,
      sku: skuRow.sku,
      credits: skuRow.credits,
      price_usdc: skuRow.price_usdc,
      balance_id: minted.record.balance_id,
      paid_at: new Date().toISOString(),
      example: false,
    },
    ua: ua ? String(ua).slice(0, 120) : undefined,
    note: 'Spend 1 credit: POST /api/orphandust/unlock {echo_id, credit_token} or GET /api/echo?echo_id=&credit_token=',
  };
}

function extractCreditToken(req, body, url) {
  return (
    (body && (body.credit_token || body.creditToken || body.odc)) ||
    (req &&
      req.headers &&
      (req.headers['x-credit-token'] || req.headers['X-CREDIT-TOKEN'] || req.headers['x-odc'])) ||
    (url && url.searchParams && (url.searchParams.get('credit_token') || url.searchParams.get('odc'))) ||
    null
  );
}

function consumeCredit({ credit_token, agent_id, ua, echo_id }) {
  const claims = verifyToken(credit_token);
  if (!claims || claims.v !== 1 || !claims.bid || !claims.jti) {
    return { ok: false, reason: 'invalid_credit_token' };
  }
  if (claims.exp && Date.now() > Number(claims.exp)) {
    return { ok: false, reason: 'credit_expired', balance_id: claims.bid };
  }

  const jtiRec = loadLedger(`jti_${claims.jti}.json`);
  if (jtiRec && (jtiRec.status === 'consumed' || jtiRec.status === 'rotated')) {
    return {
      ok: false,
      reason: 'credit_exhausted',
      balance_id: claims.bid,
      note: 'This credit_token was already spent — use the latest token from the last unlock, or buy again.',
    };
  }

  const bal = loadLedger(`bal_${claims.bid}.json`);
  let remaining = Number.isFinite(Number(claims.cr)) ? Number(claims.cr) : 0;
  if (bal && Number.isFinite(Number(bal.credits_remaining))) {
    remaining = Math.min(remaining, Number(bal.credits_remaining));
  }
  if (remaining < 1) {
    return { ok: false, reason: 'credit_exhausted', balance_id: claims.bid, sku: claims.sku };
  }

  const next = remaining - 1;
  writeLedger(`jti_${claims.jti}.json`, {
    jti: claims.jti,
    balance_id: claims.bid,
    status: 'consumed',
    consumed_at: new Date().toISOString(),
    echo_id: echo_id || null,
    agent_id: agent_id || null,
    ua: ua ? String(ua).slice(0, 120) : undefined,
  });

  const skuRow = getSku(claims.sku) || { sku: claims.sku, credits: remaining, price_usdc: null };
  const minted = mintToken({
    skuRow,
    agent_id: agent_id || claims.ag,
    credits: next,
    balance_id: claims.bid,
    payment: { unlocked_echo_id: echo_id || null },
  });
  writeLedger(`bal_${claims.bid}.json`, {
    ...(bal || {}),
    balance_id: claims.bid,
    sku: claims.sku,
    credits_remaining: next,
    last_echo_id: echo_id || null,
    last_consumed_at: new Date().toISOString(),
    last_jti: minted.claims.jti,
  });

  return {
    ok: true,
    reason: null,
    credits_remaining: next,
    credit_token: minted.credit_token,
    balance_id: claims.bid,
    sku: claims.sku,
    echo_id: echo_id || null,
  };
}

module.exports = {
  RECEIVE,
  SKUS,
  USDC_BASE,
  USDT_BSC,
  getSku,
  catalogBody,
  buildSkuInvoice,
  parsePaymentProof,
  amountsMatch,
  completePurchase,
  extractCreditToken,
  consumeCredit,
  baseUrl,
  verifyToken,
};
