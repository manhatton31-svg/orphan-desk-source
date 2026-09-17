/**
 * POST /api/feedback — structured agent feedback (+ optional bond waiver).
 */
const {
  STAGES,
  OUTCOMES,
  FEEDBACK_HINT,
  validateFeedbackBody,
  processFeedback,
  checkFeedbackRateLimit,
  logRateLimit,
  FEEDBACK_RL_MAX,
  FEEDBACK_RL_WINDOW_MS,
} = require('./_lib/feedback');

function corsHeaders(extra) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Access-Control-Allow-Headers':
      'Content-Type, Accept, X-PAYMENT, X-PAYMENT-TX, X-PAYMENT-CHAIN, X-BOND-WAIVER, X-QUOTE-ID, User-Agent',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(extra || {}),
  };
}

function json(res, status, body, extraHeaders) {
  res.statusCode = status;
  const headers = corsHeaders(extraHeaders);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

async function parseBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return json(res, 204, {});
  }

  if (req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      skill: 'feedback',
      endpoint: '/api/feedback',
      method: 'POST',
      stages: STAGES,
      outcomes: OUTCOMES,
      note_max: 500,
      rate_limit: `${FEEDBACK_RL_MAX} / ${FEEDBACK_RL_WINDOW_MS / 60000}min per IP+UA`,
      bond_waiver:
        'Valid structured feedback grants one next_firm_quote bond waiver (7d, uses=1), max one issuance per agent_id fingerprint / 24h. Pass waiver_id or X-BOND-WAIVER on firm quote_fee to skip $0.10 quote_bond.',
      hint: FEEDBACK_HINT,
      public_aggregate: '/FEEDBACK.json',
    });
  }

  if (req.method !== 'POST') {
    return json(res, 405, {
      ok: false,
      error: 'method_not_allowed',
      note: 'POST JSON {agent_id, stage, outcome, note?, echo_id?, quote_id?}',
      skill: 'feedback',
    });
  }

  const rl = checkFeedbackRateLimit(req);
  if (!rl.ok) {
    logRateLimit(req, rl);
    return json(
      res,
      429,
      {
        ok: false,
        error: 'rate_limited',
        retry_after: rl.retry_after,
        note: `Max ${FEEDBACK_RL_MAX} feedback POSTs per ${FEEDBACK_RL_WINDOW_MS / 60000} minutes per IP/UA.`,
        skill: 'feedback',
      },
      { 'Retry-After': String(rl.retry_after) }
    );
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    return json(res, 400, {
      ok: false,
      error: 'invalid_json',
      note: String(e.message || e),
      skill: 'feedback',
    });
  }

  const v = validateFeedbackBody(body);
  if (!v.ok) {
    return json(res, 400, {
      ok: false,
      error: v.error,
      allowed_stages: STAGES,
      allowed_outcomes: OUTCOMES,
      note: 'Required: agent_id (string), stage (enum), outcome (enum). Optional: echo_id, quote_id, note≤500.',
      skill: 'feedback',
      ...(v.allowed ? { allowed: v.allowed } : {}),
      ...(v.max != null ? { max: v.max } : {}),
    });
  }

  try {
    const result = processFeedback(req, v);
    return json(res, 200, {
      ...result,
      skill: 'feedback',
      hint: result.bond_waiver
        ? 'Pass bond_waiver.waiver_id (or X-BOND-WAIVER header) on next firm POST /api/quote_fee to skip quote_bond.'
        : FEEDBACK_HINT,
    });
  } catch (e) {
    return json(res, 500, {
      ok: false,
      error: 'feedback_failed',
      note: String(e.message || e),
      skill: 'feedback',
    });
  }
};
