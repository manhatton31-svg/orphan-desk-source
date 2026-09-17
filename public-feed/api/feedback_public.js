/**
 * GET /FEEDBACK.json via rewrite — live aggregate from /tmp (+ seed defaults).
 */
const fs = require('fs');
const path = require('path');
const { loadAggregate, emptyAggregate } = require('./_lib/feedback');

function loadSeed() {
  const candidates = [
    path.join(process.cwd(), 'feedback', 'FEEDBACK.seed.json'),
    path.join(process.cwd(), 'public-feed', 'feedback', 'FEEDBACK.seed.json'),
  ];
  for (const fp of candidates) {
    try {
      if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch (_) {}
  }
  return emptyAggregate();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  let agg = loadAggregate();
  if (!agg || agg.total == null) agg = loadSeed();
  agg.feedback_url = 'https://dualregistry.dev/api/feedback';
  agg.skill = 'feedback';
  agg.source = agg.total > 0 ? 'live' : 'seed_or_ephemeral';
  res.statusCode = 200;
  res.end(JSON.stringify(agg, null, 2) + '\n');
};
