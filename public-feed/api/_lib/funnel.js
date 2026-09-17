/**
 * Best-effort funnel counters for OBO→pay conversion.
 * Persists to /tmp + public-feed/stats_funnel.json when writable.
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  quotes_requested: 0,
  quotes_accepted: 0,
  quotes_countered: 0,
  quotes_rejected: 0,
  quote_bonds_collected_usdc: 0,
  accepts_without_settle: 0,
  settles: 0,
  updated_at: null,
};

function paths() {
  return [
    '/tmp/orphan-desk-funnel.json',
    path.join(process.cwd(), 'stats_funnel.json'),
    path.join(process.cwd(), 'public-feed', 'stats_funnel.json'),
  ];
}

function loadFunnel() {
  for (const fp of paths()) {
    try {
      if (fs.existsSync(fp)) {
        const obj = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (obj && typeof obj === 'object') return { ...DEFAULTS, ...obj };
      }
    } catch (_) {}
  }
  return { ...DEFAULTS };
}

function saveFunnel(data) {
  const payload = { ...DEFAULTS, ...data, updated_at: new Date().toISOString() };
  const text = JSON.stringify(payload, null, 2) + '\n';
  for (const fp of paths()) {
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, text);
    } catch (_) {}
  }
  return payload;
}

function bumpFunnel(patch) {
  const cur = loadFunnel();
  for (const [k, v] of Object.entries(patch || {})) {
    if (typeof v === 'number') {
      cur[k] = (Number(cur[k]) || 0) + v;
    } else if (v != null) {
      cur[k] = v;
    }
  }
  return saveFunnel(cur);
}

module.exports = { loadFunnel, saveFunnel, bumpFunnel, DEFAULTS };
