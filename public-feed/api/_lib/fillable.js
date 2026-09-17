/**
 * Open-book fillable gate for Orphan Desk.
 * Drop expired TTL and same-asset pairs (WETH→WETH etc) from agent surfaces.
 * Used by Echo GET (stop 402ing theater), buy 402 spend_on, and catalog prune.
 */
const fs = require('fs');
const path = require('path');

const DUST_SKU = 'od_unlock_050';
const DUST_PRICE = 0.5;
const DUST_PRICE_USDC = '0.50';

function pairOf(echo) {
  if (!echo || typeof echo !== 'object') return null;
  return echo.pair || (echo.meta && echo.meta.pair) || null;
}

function symbolsOf(echo) {
  const p = pairOf(echo);
  if (p && String(p).includes('->')) {
    const [a, b] = String(p).split('->');
    return [a.trim(), b.trim()];
  }
  const sell =
    (echo.fill_hint && echo.fill_hint.sell && echo.fill_hint.sell.symbol) ||
    (echo.sell && echo.sell.symbol) ||
    null;
  const buy =
    (echo.fill_hint && echo.fill_hint.buy && echo.fill_hint.buy.symbol) ||
    (echo.buy && echo.buy.symbol) ||
    null;
  return [sell, buy];
}

function isSameAsset(echo) {
  const [a, b] = symbolsOf(echo);
  if (!a || !b) return false;
  return String(a).toUpperCase() === String(b).toUpperCase();
}

function expiredAtMs(echo) {
  if (!echo) return null;
  const t =
    echo.expired_at ||
    echo.ttl ||
    echo.offer_expires_at ||
    (echo.meta && echo.meta.expired_at) ||
    null;
  if (!t) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

function isExpired(echo, now) {
  const n = now == null ? Date.now() : now;
  const ms = expiredAtMs(echo);
  return ms != null && ms <= n;
}

function ttlRemainingS(echo, now) {
  const n = now == null ? Date.now() : now;
  const ms = expiredAtMs(echo);
  if (ms == null) return null;
  return Math.max(0, Math.floor((ms - n) / 1000));
}

function feeOf(echo) {
  if (!echo) return NaN;
  const v =
    echo.fee_quoted_usdc ||
    (echo.x402 && echo.x402.amount) ||
    (echo.fee && (echo.fee.quoted_usdc || echo.fee.flat_usdc)) ||
    null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
}

function unfillableReason(echo, now) {
  const n = now == null ? Date.now() : now;
  const st = echo && echo.status ? echo.status : 'open';
  if (st && st !== 'open') return st;
  if (isExpired(echo, n)) return 'ttl_expired';
  if (isSameAsset(echo)) return 'same_asset';
  return null;
}

function isFillableOpen(echo, now) {
  return unfillableReason(echo, now) == null;
}

function pairClarity(echo) {
  const p = pairOf(echo) || '';
  if (p.includes('…') || /0x[0-9a-fA-F]{4}/.test(p)) return 1;
  if (p.includes('->')) return 0;
  return 2;
}

function cheapestFillable(echoes, now) {
  const n = now == null ? Date.now() : now;
  const live = (echoes || []).filter((e) => isFillableOpen(e, n));
  live.sort((a, b) => {
    const fa = feeOf(a);
    const fb = feeOf(b);
    const aFee = Number.isFinite(fa) ? fa : Number.POSITIVE_INFINITY;
    const bFee = Number.isFinite(fb) ? fb : Number.POSITIVE_INFINITY;
    if (aFee !== bFee) return aFee - bFee;
    const c = pairClarity(a) - pairClarity(b);
    if (c !== 0) return c;
    const na = a.notional_usd || 0;
    const nb = b.notional_usd || 0;
    return na - nb;
  });
  return live[0] || null;
}

function saveUsdc(fee) {
  if (!Number.isFinite(fee)) return null;
  return (fee - DUST_PRICE).toFixed(2);
}

function cheaperUnlock(echo, req, baseUrlFn) {
  const fee = feeOf(echo);
  const echoId = echo && echo.echo_id;
  let base = 'https://dualregistry.dev';
  try {
    if (typeof baseUrlFn === 'function') base = baseUrlFn(req);
  } catch (_) {}
  return {
    preferred: true,
    sku: DUST_SKU,
    price_usdc: DUST_PRICE_USDC,
    credits: 1,
    save_usdc: saveUsdc(fee),
    fee_usdc: Number.isFinite(fee) ? fee.toFixed(2) : null,
    echo_id: echoId || null,
    pair: pairOf(echo),
    buy: {
      method: 'POST',
      url: `${base}/api/orphandust/buy`,
      body: { sku: DUST_SKU },
      headers: 'After pay: retry POST with X-PAYMENT-TX + X-PAYMENT-CHAIN',
    },
    unlock_after_pay: {
      post: `${base}/api/orphandust/unlock`,
      body: { echo_id: echoId, credit_token: 'odc_…' },
      get: `${base}/api/echo?echo_id=${encodeURIComponent(echoId || '')}&credit_token=odc_…`,
    },
    note: Number.isFinite(fee)
      ? `Unlock this Echo for ${DUST_PRICE_USDC} USDC (${DUST_SKU}) instead of the ${fee.toFixed(2)} % fee.`
      : `Unlock this Echo for ${DUST_PRICE_USDC} USDC (${DUST_SKU}) instead of the % fee.`,
  };
}

function spendOnFromEcho(echo, now) {
  if (!echo) return null;
  const n = now == null ? Date.now() : now;
  const fee = feeOf(echo);
  return {
    echo_id: echo.echo_id,
    pair: pairOf(echo),
    notional_usd: echo.notional_usd != null ? echo.notional_usd : null,
    ttl_remaining_s: ttlRemainingS(echo, n),
    fee_usdc: Number.isFinite(fee) ? fee.toFixed(2) : null,
    save_usdc: saveUsdc(fee),
    sku: DUST_SKU,
    price_usdc: DUST_PRICE_USDC,
    chain: echo.chain || null,
    unlock: {
      post: '/api/orphandust/unlock',
      body: { echo_id: echo.echo_id, credit_token: 'odc_…' },
    },
    note: 'Cheapest live fillable Echo — spend 1 OrphanDust credit after buy.',
  };
}

function loadIndexEchoes() {
  const candidates = [
    path.join(process.cwd(), 'index.json'),
    path.join(process.cwd(), 'public-feed', 'index.json'),
    path.join(__dirname, '..', '..', 'index.json'),
  ];
  for (const fp of candidates) {
    try {
      if (fs.existsSync(fp)) {
        const idx = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (Array.isArray(idx.echoes)) return idx.echoes;
        if (idx.echoes && Array.isArray(idx.echoes.items)) return idx.echoes.items;
      }
    } catch (_) {}
  }
  return [];
}

function spendOnForBuy(now) {
  const n = now == null ? Date.now() : now;
  const cheapest = cheapestFillable(loadIndexEchoes(), n);
  return spendOnFromEcho(cheapest, n);
}

function goneBody(echo, reason, req, baseUrlFn) {
  let base = 'https://dualregistry.dev';
  try {
    if (typeof baseUrlFn === 'function') base = baseUrlFn(req);
  } catch (_) {}
  return {
    schema_version: '1.0.0',
    type: 'echo_unfillable',
    status: 410,
    http_status: 410,
    reason: reason || 'unfillable',
    echo_id: echo && echo.echo_id,
    pair: pairOf(echo),
    expired_at: echo && echo.expired_at,
    chain: echo && echo.chain,
    note:
      reason === 'same_asset'
        ? 'Dropped from open book — same-asset pair (unfillable theater). Not 402.'
        : 'Dropped from open book — expired TTL. Not 402.',
    index_url: `${base}/index.json`,
    fill_hint_url: `${base}/fill_hint.json`,
    orphandust: {
      catalog: `${base}/ORPHANDUST.json`,
      buy: `${base}/api/orphandust/buy`,
      note: 'Buy od_unlock_050 to unlock a live fillable Echo from /index.json',
    },
    skill: 'redeem',
  };
}

module.exports = {
  DUST_SKU,
  DUST_PRICE,
  DUST_PRICE_USDC,
  pairOf,
  symbolsOf,
  isSameAsset,
  isExpired,
  ttlRemainingS,
  feeOf,
  unfillableReason,
  isFillableOpen,
  cheapestFillable,
  cheaperUnlock,
  spendOnFromEcho,
  spendOnForBuy,
  loadIndexEchoes,
  goneBody,
};
