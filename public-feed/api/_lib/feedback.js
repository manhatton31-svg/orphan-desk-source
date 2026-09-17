/**
 * Agent feedback loop + one-time firm-quote bond waivers.
 * Persist append-only best-effort to /tmp + public-feed/feedback/raw/ (or echo/feed/feedback/).
 * Public aggregate: FEEDBACK.json (counts + note hashes only — no raw notes).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { checkRateLimit, logRateLimit, ipHash } = require('./rate_limit');

const STAGES = ['preview', 'quote', 'bond', 'paywall_402', 'settle', 'fill', 'skip'];
const OUTCOMES = [
  'too_expensive',
  'legs_unclear',
  'ttl_too_short',
  'wrong_chain',
  'cant_pay_x402',
  'filled_ok',
  'bond_friction',
  'other',
];

const FEEDBACK_RL_MAX = 5;
const FEEDBACK_RL_WINDOW_MS = 10 * 60 * 1000;
const WAIVER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const WAIVER_ISSUANCE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const NOTE_MAX = 500;
const WAIVER_SECRET =
  process.env.ORPHAN_DESK_WAIVER_SECRET ||
  process.env.ORPHAN_DESK_SECRET ||
  'orphan-desk-feedback-waiver-v1|0x459cF7359e37B45A0d2a2479656cD96cdA9F7dBb';

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
function fromB64url(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64');
}
function signWaiverPayload(obj) {
  const payload = b64url(JSON.stringify(obj));
  const sig = b64url(crypto.createHmac('sha256', WAIVER_SECRET).update(payload).digest());
  return `bw_${payload}.${sig}`;
}
function verifySignedWaiver(token) {
  if (!token || typeof token !== 'string' || !token.startsWith('bw_')) return null;
  const raw = token.slice(3);
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expect = b64url(crypto.createHmac('sha256', WAIVER_SECRET).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(fromB64url(payload).toString('utf8'));
  } catch (_) {
    return null;
  }
}

const FEEDBACK_HINT =
  'POST /api/feedback why you paid or skipped (stage+outcome). quote_bond_usdc=0; waiver still issued for compat. OrphanDust flat unlocks: /ORPHANDUST.json.';

function feedbackMeta(req) {
  const base = baseUrl(req);
  return {
    feedback_url: `${base}/api/feedback`,
    feedback_skill: 'feedback',
    feedback_hint: FEEDBACK_HINT,
  };
}

function baseUrl(req) {
  const host = (req && (req.headers['x-forwarded-host'] || req.headers.host)) || 'dualregistry.dev';
  const proto = ((req && req.headers['x-forwarded-proto']) || 'https').split(',')[0].trim();
  return `${proto}://${host}`;
}

function captureRequestMeta(req) {
  const ua = String(req.headers['user-agent'] || '').slice(0, 256);
  const country =
    String(
      req.headers['x-vercel-ip-country'] ||
        req.headers['cf-ipcountry'] ||
        req.headers['x-country'] ||
        ''
    )
      .toUpperCase()
      .slice(0, 8) || null;
  return {
    ua,
    country,
    ipHash: ipHash(req),
  };
}

function agentFingerprint(agentId, ua) {
  const raw = `${String(agentId || '').trim().toLowerCase()}|${String(ua || '').slice(0, 128)}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

function noteHash(note) {
  if (!note || typeof note !== 'string') return null;
  return crypto.createHash('sha256').update(note).digest('hex').slice(0, 16);
}

function rawDirs() {
  return [
    '/tmp/orphan-desk-feedback/raw',
    path.join(process.cwd(), 'feedback', 'raw'),
    path.join(process.cwd(), 'public-feed', 'feedback', 'raw'),
    path.join(process.cwd(), 'echo', 'feed', 'feedback'),
  ];
}

function waiverDirs() {
  return [
    '/tmp/orphan-desk-feedback/waivers',
    path.join(process.cwd(), 'feedback', 'waivers'),
    path.join(process.cwd(), 'public-feed', 'feedback', 'waivers'),
  ];
}

function aggregatePaths() {
  return [
    '/tmp/orphan-desk-feedback/FEEDBACK.json',
    path.join(process.cwd(), 'FEEDBACK.json'),
    path.join(process.cwd(), 'public-feed', 'FEEDBACK.json'),
  ];
}

function issuancePaths() {
  return [
    '/tmp/orphan-desk-feedback/waiver_issuance.json',
    path.join(process.cwd(), 'feedback', 'waiver_issuance.json'),
    path.join(process.cwd(), 'public-feed', 'feedback', 'waiver_issuance.json'),
  ];
}

function emptyAggregate() {
  return {
    desk: 'Scro Orphan Desk',
    audience: 'agents',
    total: 0,
    by_outcome: Object.fromEntries(OUTCOMES.map((o) => [o, 0])),
    by_stage: Object.fromEntries(STAGES.map((s) => [s, 0])),
    last_at: null,
    sample_note_hashes: [],
    bond_waivers_issued: 0,
    updated_at: null,
    note: 'Aggregated counts only — no raw notes. POST /api/feedback for structured agent feedback.',
  };
}

function loadAggregate() {
  for (const fp of aggregatePaths()) {
    try {
      if (fs.existsSync(fp)) {
        const obj = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (obj && typeof obj === 'object') {
          return {
            ...emptyAggregate(),
            ...obj,
            by_outcome: { ...emptyAggregate().by_outcome, ...(obj.by_outcome || {}) },
            by_stage: { ...emptyAggregate().by_stage, ...(obj.by_stage || {}) },
            sample_note_hashes: Array.isArray(obj.sample_note_hashes)
              ? obj.sample_note_hashes.slice(0, 32)
              : [],
          };
        }
      }
    } catch (_) {}
  }
  return emptyAggregate();
}

function saveAggregate(agg) {
  const payload = {
    ...agg,
    updated_at: new Date().toISOString(),
  };
  const text = JSON.stringify(payload, null, 2) + '\n';
  for (const fp of aggregatePaths()) {
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, text);
    } catch (_) {}
  }
  return payload;
}

function persistRaw(record) {
  const name = `${record.feedback_id}.json`;
  const text = JSON.stringify(record) + '\n';
  const wrote = [];
  for (const dir of rawDirs()) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const fp = path.join(dir, name);
      fs.writeFileSync(fp, text);
      wrote.push(fp);
    } catch (_) {}
  }
  return wrote;
}

function loadIssuance() {
  for (const fp of issuancePaths()) {
    try {
      if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch (_) {}
  }
  return { by_agent: {} };
}

function saveIssuance(store) {
  const text = JSON.stringify(store);
  for (const fp of issuancePaths()) {
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, text);
    } catch (_) {}
  }
}

function canIssueWaiver(agentFp) {
  const store = loadIssuance();
  const row = store.by_agent && store.by_agent[agentFp];
  if (!row || !row.last_issued_at) return { ok: true };
  const last = Date.parse(row.last_issued_at);
  if (!Number.isFinite(last)) return { ok: true };
  const elapsed = Date.now() - last;
  if (elapsed < WAIVER_ISSUANCE_COOLDOWN_MS) {
    return {
      ok: false,
      retry_after_s: Math.ceil((WAIVER_ISSUANCE_COOLDOWN_MS - elapsed) / 1000),
      last_issued_at: row.last_issued_at,
    };
  }
  return { ok: true };
}

function markIssued(agentFp, waiverId) {
  const store = loadIssuance();
  if (!store.by_agent) store.by_agent = {};
  store.by_agent[agentFp] = {
    last_issued_at: new Date().toISOString(),
    waiver_id: waiverId,
  };
  saveIssuance(store);
}

function persistWaiver(waiver) {
  const name = `${waiver.waiver_id}.json`;
  const text = JSON.stringify(waiver);
  for (const dir of waiverDirs()) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), text);
    } catch (_) {}
  }
}

function loadWaiver(waiverId) {
  if (!waiverId || typeof waiverId !== 'string') return null;
  const id = waiverId.trim();
  // Prefer HMAC-signed self-contained token (works across serverless instances)
  const signed = verifySignedWaiver(id);
  if (signed && signed.jti) {
    // Merge used flag from /tmp if present
    let used = false;
    let used_at = null;
    for (const dir of waiverDirs()) {
      try {
        const fp = path.join(dir, `used_${signed.jti}.json`);
        if (fs.existsSync(fp)) {
          const u = JSON.parse(fs.readFileSync(fp, 'utf8'));
          used = true;
          used_at = u.used_at || true;
          break;
        }
      } catch (_) {}
    }
    return {
      waiver_id: id,
      agent_id: signed.agent_id,
      agent_fp: signed.agent_fp,
      feedback_id: signed.feedback_id,
      expires_at: signed.expires_at,
      uses_remaining: used ? 0 : 1,
      applies_to: signed.applies_to || 'next_firm_quote',
      created_at: signed.created_at,
      used_at,
      jti: signed.jti,
      signed: true,
    };
  }
  // Legacy file-based waivers (same-instance /tmp)
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 200);
  for (const dir of waiverDirs()) {
    try {
      const fp = path.join(dir, `${safe}.json`);
      if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch (_) {}
  }
  return null;
}

function issueWaiver({ agent_id, agent_fp, feedback_id }) {
  const jti = crypto.randomBytes(12).toString('hex');
  const expires_at = new Date(Date.now() + WAIVER_TTL_MS).toISOString();
  const created_at = new Date().toISOString();
  const core = {
    jti,
    agent_id: String(agent_id).slice(0, 128),
    agent_fp,
    feedback_id,
    expires_at,
    uses_remaining: 1,
    applies_to: 'next_firm_quote',
    created_at,
  };
  const waiver_id = signWaiverPayload(core);
  const waiver = { ...core, waiver_id, used_at: null };
  persistWaiver(waiver);
  // Also index by jti for used-marking
  try {
    for (const dir of waiverDirs()) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `jti_${jti}.json`), JSON.stringify(waiver));
    }
  } catch (_) {}
  markIssued(agent_fp, waiver_id);
  return waiver;
}

/**
 * Consume a valid unused waiver for this agent fingerprint.
 * @returns {{ ok: true, waiver } | { ok: false, reason }}
 */
function consumeWaiver({ waiver_id, agent_id, ua }) {
  const w = loadWaiver(waiver_id);
  if (!w) return { ok: false, reason: 'waiver_not_found' };
  const exp = Date.parse(w.expires_at);
  if (Number.isFinite(exp) && Date.now() > exp) return { ok: false, reason: 'waiver_expired' };
  if ((w.uses_remaining || 0) < 1) return { ok: false, reason: 'waiver_used' };
  const fp = agentFingerprint(agent_id || w.agent_id, ua);
  // Match either exact agent_fp on record, or fingerprint from request agent_id+UA,
  // or agent_id string equality when UA differs across retries.
  const idOk =
    (w.agent_fp && (w.agent_fp === fp || w.agent_fp === agentFingerprint(w.agent_id, ua))) ||
    (agent_id &&
      String(w.agent_id || '').toLowerCase() === String(agent_id).trim().toLowerCase());
  if (!idOk) return { ok: false, reason: 'waiver_agent_mismatch' };
  w.uses_remaining = 0;
  w.used_at = new Date().toISOString();
  persistWaiver(w);
  if (w.jti) {
    const marker = { jti: w.jti, used_at: w.used_at, waiver_id: w.waiver_id };
    for (const dir of waiverDirs()) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `used_${w.jti}.json`), JSON.stringify(marker));
      } catch (_) {}
    }
  }
  return { ok: true, waiver: w };
}

/**
 * Peek without consuming — for negotiate decision path before commit.
 */
function peekWaiver({ waiver_id, agent_id, ua }) {
  const w = loadWaiver(waiver_id);
  if (!w) return { ok: false, reason: 'waiver_not_found' };
  const exp = Date.parse(w.expires_at);
  if (Number.isFinite(exp) && Date.now() > exp) return { ok: false, reason: 'waiver_expired' };
  if ((w.uses_remaining || 0) < 1) return { ok: false, reason: 'waiver_used' };
  const fp = agentFingerprint(agent_id || w.agent_id, ua);
  const idOk =
    (w.agent_fp && (w.agent_fp === fp || w.agent_fp === agentFingerprint(w.agent_id, ua))) ||
    (agent_id &&
      String(w.agent_id || '').toLowerCase() === String(agent_id).trim().toLowerCase());
  if (!idOk) return { ok: false, reason: 'waiver_agent_mismatch' };
  return { ok: true, waiver: w };
}

function validateFeedbackBody(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'invalid_body' };
  }
  const agent_id = body.agent_id;
  if (!agent_id || typeof agent_id !== 'string' || !agent_id.trim()) {
    return { ok: false, error: 'missing_agent_id' };
  }
  if (agent_id.length > 128) return { ok: false, error: 'agent_id_too_long' };

  const stage = body.stage;
  if (!stage || !STAGES.includes(stage)) {
    return { ok: false, error: 'invalid_stage', allowed: STAGES };
  }
  const outcome = body.outcome;
  if (!outcome || !OUTCOMES.includes(outcome)) {
    return { ok: false, error: 'invalid_outcome', allowed: OUTCOMES };
  }

  let note = body.note;
  if (note != null) {
    if (typeof note !== 'string') return { ok: false, error: 'invalid_note' };
    if (note.length > NOTE_MAX) return { ok: false, error: 'note_too_long', max: NOTE_MAX };
  } else {
    note = undefined;
  }

  const echo_id = body.echo_id != null ? String(body.echo_id).slice(0, 256) : undefined;
  const quote_id = body.quote_id != null ? String(body.quote_id).slice(0, 128) : undefined;

  return {
    ok: true,
    agent_id: agent_id.trim(),
    stage,
    outcome,
    note,
    echo_id,
    quote_id,
  };
}

function bumpStatsFeedback(agg) {
  // Best-effort patch of stats.json feedback fields when FS writable
  const candidates = [
    path.join(process.cwd(), 'stats.json'),
    path.join(process.cwd(), 'public-feed', 'stats.json'),
  ];
  for (const fp of candidates) {
    try {
      if (!fs.existsSync(fp)) continue;
      const stats = JSON.parse(fs.readFileSync(fp, 'utf8'));
      stats.feedback_total = agg.total;
      stats.feedback_by_outcome = { ...(agg.by_outcome || {}) };
      stats.bond_waivers_issued = agg.bond_waivers_issued || 0;
      stats.feedback_url = 'https://dualregistry.dev/FEEDBACK.json';
      stats.updated_at = new Date().toISOString();
      fs.writeFileSync(fp, JSON.stringify(stats, null, 2) + '\n');
    } catch (_) {}
  }
}

/**
 * Process a validated feedback submission. Returns response body fields.
 */
function processFeedback(req, validated) {
  const meta = captureRequestMeta(req);
  const agent_fp = agentFingerprint(validated.agent_id, meta.ua);
  const feedback_id = `fb_${crypto.randomBytes(12).toString('hex')}`;
  const at = new Date().toISOString();

  const record = {
    feedback_id,
    agent_id: validated.agent_id,
    agent_fp,
    echo_id: validated.echo_id,
    quote_id: validated.quote_id,
    stage: validated.stage,
    outcome: validated.outcome,
    note: validated.note,
    note_hash: noteHash(validated.note),
    ua: meta.ua,
    country: meta.country,
    ipHash: meta.ipHash,
    at,
  };
  const wrote = persistRaw(record);

  const agg = loadAggregate();
  agg.total = (agg.total || 0) + 1;
  agg.by_outcome[validated.outcome] = (agg.by_outcome[validated.outcome] || 0) + 1;
  agg.by_stage[validated.stage] = (agg.by_stage[validated.stage] || 0) + 1;
  agg.last_at = at;
  if (record.note_hash) {
    const hashes = Array.isArray(agg.sample_note_hashes) ? agg.sample_note_hashes : [];
    hashes.unshift(record.note_hash);
    agg.sample_note_hashes = [...new Set(hashes)].slice(0, 32);
  }

  let bond_waiver = undefined;
  const gate = canIssueWaiver(agent_fp);
  if (gate.ok) {
    const w = issueWaiver({
      agent_id: validated.agent_id,
      agent_fp,
      feedback_id,
    });
    agg.bond_waivers_issued = (agg.bond_waivers_issued || 0) + 1;
    bond_waiver = {
      waiver_id: w.waiver_id,
      expires_at: w.expires_at,
      applies_to: 'next_firm_quote',
    };
  }

  const saved = saveAggregate(agg);
  try {
    bumpStatsFeedback(saved);
  } catch (_) {}

  return {
    ok: true,
    feedback_id,
    bond_waiver,
    bond_waiver_skipped: bond_waiver
      ? undefined
      : {
          reason: 'one_waiver_per_agent_per_24h',
          retry_after_s: gate.retry_after_s,
          last_issued_at: gate.last_issued_at,
        },
    persist: { wrote: wrote.length, ephemeral: wrote.length === 0 },
    aggregate: {
      total: saved.total,
      by_outcome: saved.by_outcome,
      last_at: saved.last_at,
    },
  };
}

function extractWaiverId(req, body) {
  const h =
    (req.headers &&
      (req.headers['x-bond-waiver'] ||
        req.headers['X-BOND-WAIVER'] ||
        req.headers['x-od-bond-waiver'])) ||
    null;
  if (h && String(h).trim()) return String(h).trim();
  if (body && (body.waiver_id || body.bond_waiver_id || body.bondWaiverId)) {
    return String(body.waiver_id || body.bond_waiver_id || body.bondWaiverId).trim();
  }
  return null;
}

module.exports = {
  STAGES,
  OUTCOMES,
  FEEDBACK_RL_MAX,
  FEEDBACK_RL_WINDOW_MS,
  FEEDBACK_HINT,
  feedbackMeta,
  captureRequestMeta,
  agentFingerprint,
  validateFeedbackBody,
  processFeedback,
  loadAggregate,
  saveAggregate,
  peekWaiver,
  consumeWaiver,
  extractWaiverId,
  checkFeedbackRateLimit(req) {
    return checkRateLimit(req, { max: FEEDBACK_RL_MAX, windowMs: FEEDBACK_RL_WINDOW_MS });
  },
  logRateLimit,
  emptyAggregate,
};
