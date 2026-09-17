/**
 * Best-effort in-memory + /tmp rate limit for OBO fee POSTs.
 * Default: 10 requests / 10 minutes per IP hash (and UA salt).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQ = 10;
const STORE = '/tmp/orphan-desk-rate.json';

function ipHash(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || '';
  return crypto.createHash('sha256').update(`${ip}|${ua}`).digest('hex').slice(0, 16);
}

function loadStore() {
  try {
    if (fs.existsSync(STORE)) return JSON.parse(fs.readFileSync(STORE, 'utf8'));
  } catch (_) {}
  return { buckets: {} };
}

function saveStore(store) {
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify(store));
  } catch (_) {}
}

/**
 * @returns {{ ok: true, remaining: number, ip_hash: string } | { ok: false, retry_after: number, ip_hash: string }}
 */
function checkRateLimit(req, { max = MAX_REQ, windowMs = WINDOW_MS } = {}) {
  const key = ipHash(req);
  const now = Date.now();
  const store = loadStore();
  const buckets = store.buckets || {};
  let bucket = buckets[key];
  if (!bucket || now - bucket.window_start >= windowMs) {
    bucket = { window_start: now, count: 0 };
  }
  bucket.count += 1;
  buckets[key] = bucket;
  // prune stale
  for (const k of Object.keys(buckets)) {
    if (now - (buckets[k].window_start || 0) > windowMs * 2) delete buckets[k];
  }
  store.buckets = buckets;
  saveStore(store);

  if (bucket.count > max) {
    const retryAfter = Math.max(1, Math.ceil((bucket.window_start + windowMs - now) / 1000));
    return { ok: false, retry_after: retryAfter, ip_hash: key, count: bucket.count, max };
  }
  return { ok: true, remaining: Math.max(0, max - bucket.count), ip_hash: key, count: bucket.count, max };
}

function logRateLimit(req, info) {
  try {
    console.log(
      JSON.stringify({
        type: 'agent_json_hit',
        event: 'rate_limit',
        method: req.method,
        path: (req.url || '').split('?')[0],
        ipHash: info.ip_hash,
        count: info.count,
        max: info.max,
        retry_after: info.retry_after || 0,
        at: new Date().toISOString(),
      })
    );
  } catch (_) {}
}

module.exports = {
  checkRateLimit,
  logRateLimit,
  ipHash,
  WINDOW_MS,
  MAX_REQ,
};
