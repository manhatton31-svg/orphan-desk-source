/**
 * POST /api/orphandust/unlock — {echo_id, credit_token|balance proof} → consume 1 credit, full echo
 */
const {
  consumeCredit,
  extractCreditToken,
  baseUrl,
} = require('../_lib/orphandust');
const { feedbackMeta } = require('../_lib/feedback');
const { parseBody, json, loadEcho } = require('../_lib/negotiate');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return json(res, 204, {});
  }
  if (req.method !== 'POST') {
    return json(res, 405, {
      ok: false,
      reason: 'method_not_allowed',
      note: 'POST JSON {echo_id, credit_token} — consumes 1 unlock credit, returns full echo legs',
      skill: 'orphandust',
      alt: 'GET /api/echo?echo_id=…&credit_token=odc_…',
    });
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    return json(res, 400, { ok: false, reason: 'invalid_json', note: String(e.message || e) });
  }

  const echo_id = body.echo_id || body.echoId || null;
  if (!echo_id) {
    return json(res, 400, { ok: false, reason: 'missing_echo_id', skill: 'orphandust' });
  }

  const credit_token = extractCreditToken(req, body, null);
  if (!credit_token) {
    return json(res, 400, {
      ok: false,
      reason: 'missing_credit_token',
      note: 'Pass credit_token from OrphanDust buy (body or X-CREDIT-TOKEN)',
      buy: `${baseUrl(req)}/api/orphandust/buy`,
      skill: 'orphandust',
    });
  }

  const agent_id = body.agent_id ? String(body.agent_id).slice(0, 128) : null;
  const ua = (req.headers && req.headers['user-agent']) || '';

  const spent = consumeCredit({ credit_token, agent_id, ua, echo_id });
  if (!spent.ok) {
    return json(res, 402, {
      ok: false,
      reason: spent.reason,
      skill: 'orphandust',
      buy: `${baseUrl(req)}/api/orphandust/buy`,
      catalog: `${baseUrl(req)}/ORPHANDUST.json`,
      ...feedbackMeta(req),
    });
  }

  const loaded = await loadEcho(req, echo_id);
  if (loaded.error) {
    return json(res, loaded.error === 'echo_not_found' ? 404 : 502, {
      ok: false,
      reason: loaded.error,
      echo_id,
      credit_token: spent.credit_token,
      credits_remaining: spent.credits_remaining,
      note: 'Credit was consumed but echo load failed — contact via feedback with balance_id',
      balance_id: spent.balance_id,
      skill: 'orphandust',
    });
  }

  const echo = loaded.echo;
  return json(res, 200, {
    ok: true,
    unlocked_via: 'orphandust_credit',
    credits_remaining: spent.credits_remaining,
    credit_token: spent.credit_token,
    balance_id: spent.balance_id,
    sku: spent.sku,
    echo: {
      ...echo,
      status: echo.status || 'open',
      meta: {
        ...(echo.meta || {}),
        unlocked_via: 'orphandust_credit',
        orphandust_balance_id: spent.balance_id,
      },
    },
    echo_id: echo.echo_id,
    note: 'Full legs unlocked via OrphanDust credit (no % fee charged for this echo).',
    skill: 'orphandust',
    ...feedbackMeta(req),
  });
};
