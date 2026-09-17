/**
 * Orphan Desk OBO fee negotiation (deterministic).
 *
 * Rules:
 *   bid_bps >= ask_bps              → accept at bid_bps → HTTP 402 invoice
 *   floor_bps <= bid_bps < ask_bps  → counter at midpoint ceil((ask+bid)/2) → 200
 *   bid_bps < floor_bps             → reject → 422/400
 *
 * Firm quotes (accept / binding counter): quote_bond_usdc=0 (no bond required).
 * Waiver path kept for compatibility. Exploratory (firm!=true) returns indicative
 * ask/floor only (200) — never accept-402.
 *
 * Rate limit: ~10 POST / 10 min per IP hash (best-effort /tmp).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { checkRateLimit, logRateLimit, MAX_REQ, WINDOW_MS } = require('./rate_limit');
const { bumpFunnel } = require('./funnel');
const { buildInvoice, USDC_BASE, USDT_BSC } = require('./x402');
const {
  feedbackMeta,
  peekWaiver,
  consumeWaiver,
  extractWaiverId,
} = require('./feedback');

const RECEIVE = '0x459cF7359e37B45A0d2a2479656cD96cdA9F7dBb';
const DEFAULT_ASK = 25;
const DEFAULT_FLOOR = 10;
const TTL_MS = 20 * 60 * 1000; // 20 minutes
const QUOTE_BOND_USDC = '0'; // OrphanDust freeze-breaker: zero bond; keep waiver code

function corsHeaders(extra) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Accept, X-PAYMENT, X-PAYMENT-TX, X-PAYMENT-CHAIN, X-PAYMENT-ASSET, X-PAYMENT-AMOUNT, X-PAYMENT-PAYER, X-QUOTE-ID, X-BOND-WAIVER, X-CREDIT-TOKEN, PAYMENT-TX, PAYMENT-CHAIN',
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

function baseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'dualregistry.dev';
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return `${proto}://${host}`;
}

async function readJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json', 'x-od-internal': '1' } });
  if (!r.ok) {
    const err = new Error(`fetch ${url} → ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

async function loadEcho(req, echoId) {
  if (!echoId || typeof echoId !== 'string') return { error: 'missing_echo_id' };
  const base = baseUrl(req);
  let index;
  try {
    index = await readJson(`${base}/index.json`);
  } catch (e) {
    return { error: 'index_unavailable', detail: String(e.message || e) };
  }
  const echoes = Array.isArray(index.echoes) ? index.echoes : [];
  let entry = echoes.find((e) => e.echo_id === echoId);
  if (!entry) {
    entry = echoes.find(
      (e) =>
        e.path === echoId ||
        e.path === `${echoId}.echo.json` ||
        e.order_uid === echoId
    );
  }
  if (!entry) {
    const candidates = [
      echoId.endsWith('.echo.json') ? echoId : `${echoId}.echo.json`,
      echoId,
    ];
    for (const p of candidates) {
      try {
        const echo = await readJson(`${base}/${p}`);
        if (echo && echo.echo_id) return { echo, path: p, from: 'direct' };
      } catch (_) {
        /* continue */
      }
    }
    return { error: 'echo_not_found', echo_id: echoId };
  }
  try {
    const echo = await readJson(`${base}/${entry.path}`);
    return { echo, path: entry.path, from: 'index', entry };
  } catch (e) {
    return { error: 'echo_fetch_failed', echo_id: echoId, path: entry.path, detail: String(e.message || e) };
  }
}

function askFloor(echo) {
  const fee = echo.fee || {};
  const ask = Number.isFinite(+fee.ask_bps) ? +fee.ask_bps : Number.isFinite(+fee.bps) ? +fee.bps : DEFAULT_ASK;
  const floor = Number.isFinite(+fee.floor_bps) ? +fee.floor_bps : DEFAULT_FLOOR;
  return { ask_bps: ask, floor_bps: floor, fee };
}

function finalUsdc(echo, finalBps, askBps) {
  const fee = echo.fee || {};
  const quoted = fee.quoted_usdc != null ? parseFloat(fee.quoted_usdc) : NaN;
  const ask = askBps || fee.ask_bps || fee.bps || DEFAULT_ASK;
  if (Number.isFinite(quoted) && ask > 0) {
    return (quoted * (finalBps / ask)).toFixed(2);
  }
  const notional = echo.notional_usd != null ? +echo.notional_usd : NaN;
  if (Number.isFinite(notional)) {
    return ((notional * finalBps) / 10000).toFixed(2);
  }
  if (Number.isFinite(quoted)) return quoted.toFixed(2);
  return null;
}

function midpointCounter(askBps, bidBps) {
  return Math.ceil((askBps + bidBps) / 2);
}

function makeQuoteId(echoId, bidBps, status) {
  const raw = `${echoId}|${bidBps}|${status}|${Date.now()}|${crypto.randomBytes(6).toString('hex')}`;
  return `fq_${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
}

function quoteDirs() {
  return ['/tmp/orphan-desk-quotes', path.join(process.cwd(), 'quotes')];
}

function persistQuote(record) {
  for (const dir of quoteDirs()) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const fp = path.join(dir, `${record.quote_id}.json`);
      fs.writeFileSync(fp, JSON.stringify(record));
      return { stored: true, path: fp };
    } catch (_) {
      /* try next */
    }
  }
  return { stored: false, ephemeral: true };
}

function loadQuote(quoteId) {
  if (!quoteId) return null;
  for (const dir of quoteDirs()) {
    try {
      const fp = path.join(dir, `${quoteId}.json`);
      if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch (_) {}
  }
  return null;
}

/**
 * Verify quote_id for paid unlock: matches echo, not expired, amount/asset consistent.
 */
function verifyQuoteForUnlock(quote, { echoId, amount, asset }) {
  if (!quote) return { ok: false, reason: 'quote_not_found' };
  if (quote.echo_id && echoId && quote.echo_id !== echoId) {
    return { ok: false, reason: 'quote_echo_mismatch' };
  }
  if (quote.expires_at) {
    const exp = Date.parse(quote.expires_at);
    if (Number.isFinite(exp) && Date.now() > exp) {
      return { ok: false, reason: 'quote_expired' };
    }
  }
  if (quote.status && quote.status !== 'accept' && quote.status !== 'counter') {
    return { ok: false, reason: 'quote_not_binding' };
  }
  if (amount != null && quote.final_usdc != null) {
    const a = parseFloat(amount);
    const q = parseFloat(quote.final_usdc);
    if (Number.isFinite(a) && Number.isFinite(q) && Math.abs(a - q) > 0.02) {
      return { ok: false, reason: 'quote_amount_mismatch', expected: quote.final_usdc, got: amount };
    }
  }
  if (asset && quote.x402 && quote.x402.asset) {
    if (String(asset).toUpperCase() !== String(quote.x402.asset).toUpperCase() &&
        !['USDC', 'USDT'].includes(String(asset).toUpperCase())) {
      return { ok: false, reason: 'quote_asset_mismatch' };
    }
  }
  return { ok: true, quote };
}

function buildX402(echo, finalUsdcAmt) {
  const x = echo.x402 || {};
  return {
    asset: x.asset || 'USDC',
    pay_to: x.pay_to || RECEIVE,
    amount: finalUsdcAmt,
    network: x.network || 'base',
    decimals: x.decimals != null ? x.decimals : 6,
  };
}

function buildAccept402Invoice(echo, req, { final_usdc, quote_id, expires_at, final_bps, ask_bps, floor_bps, bid_bps, skill }) {
  const baseInvoice = buildInvoice(
    {
      ...echo,
      fee: {
        ...(echo.fee || {}),
        quoted_usdc: final_usdc,
        ask_bps,
        floor_bps,
      },
      x402: {
        ...(echo.x402 || {}),
        amount: final_usdc,
      },
    },
    req
  );
  return {
    ...baseInvoice,
    type: 'x402_payment_required',
    status: 'accept',
    decision: 'accept',
    http_status: 402,
    quote_id,
    echo_id: echo.echo_id,
    amount: String(final_usdc),
    amount_usdc: String(final_usdc),
    final_usdc: String(final_usdc),
    final_bps,
    ask_bps,
    floor_bps,
    bid_bps,
    expires_at,
    ttl_seconds: Math.floor(TTL_MS / 1000),
    receive_wallet: RECEIVE,
    receive_address: RECEIVE,
    skill: skill || 'quote_fee',
    preferred: {
      asset: 'USDC',
      network: 'base',
      chain_id: 8453,
      token: USDC_BASE,
      decimals: 6,
      pay_to: RECEIVE,
      amount: String(final_usdc),
    },
    unlock: {
      ...(baseInvoice.unlock || {}),
      after_accept_402:
        'Pay invoice amount to receive wallet, then GET /api/echo (or *.echo.json) with X-PAYMENT-TX + X-PAYMENT-CHAIN (+ optional X-QUOTE-ID / X-PAYMENT-AMOUNT). quote_id binds terms for ~20m TTL.',
      quote_id_header: 'X-QUOTE-ID',
    },
    note: 'bid_bps >= ask_bps → accept; HTTP 402 machine invoice — pay then unlock legs with payment proof + quote_id',
    rule: 'accept if bid>=ask (at bid); counter midpoint if floor<=bid<ask; reject if bid<floor',
    ...feedbackMeta(req),
  };
}

function buildBondInvoice(echo, req, { skill, ask_bps, floor_bps }) {
  const base = baseUrl(req);
  const amount = QUOTE_BOND_USDC;
  return {
    schema_version: '1.0.0',
    type: 'x402_bond_required',
    status: 'bond_required',
    decision: 'bond_required',
    http_status: 402,
    echo_id: echo.echo_id,
    amount: amount,
    amount_usdc: amount,
    quote_bond_usdc: amount,
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
    ask_bps,
    floor_bps,
    skill: skill || 'quote_fee',
    note:
      'Firm quote (accept or binding counter) requires a tiny USDC bond. Pay bond to receive wallet, then retry POST with firm=true + bond_tx_hash (+ bond_chain). Or POST /api/feedback for a one-time bond waiver, then retry with waiver_id / X-BOND-WAIVER. Exploratory (omit firm) returns indicative ask/floor only.',
    retry: {
      post: `${base}/api/quote_fee`,
      body_after_bond: {
        echo_id: echo.echo_id,
        bid_bps: ask_bps,
        firm: true,
        bond_tx_hash: '0x…',
        bond_chain: 'base',
      },
      body_after_waiver: {
        echo_id: echo.echo_id,
        bid_bps: ask_bps,
        firm: true,
        waiver_id: 'bw_…',
      },
    },
    ...feedbackMeta(req),
  };
}

function hasBondProof(body) {
  const tx = body.bond_tx_hash || body.bond_tx || body.bondTxHash;
  if (!tx || typeof tx !== 'string') return false;
  return /^0x[0-9a-fA-F]{64}$/.test(tx);
}

function wantsFirm(body) {
  if (body.firm === true || body.firm === 'true' || body.firm === 1) return true;
  if (body.bond === true || body.bond === 'true') return true;
  if (hasBondProof(body)) return true;
  if (body.binding === true || body.mode === 'firm') return true;
  return false;
}

/**
 * Core negotiate. Returns { http, body, extraHeaders? }.
 */
function negotiate({ echo, bid_bps, bid_usdc, agent_id, x402_payment_intent, skill, firm, bond_tx_hash, bond_chain, waiver_id, req }) {
  const { ask_bps, floor_bps } = askFloor(echo);
  const echoId = echo.echo_id;
  const now = Date.now();
  const expires_at = new Date(now + TTL_MS).toISOString();
  const receive_address = (echo.fee && echo.fee.receive_address) || RECEIVE;

  if (echo.status && echo.status !== 'open') {
    return {
      http: 409,
      body: {
        status: 'reject', decision: 'reject', echo_id: echoId, reason: 'echo_not_open', echo_status: echo.status,
        ask_bps, floor_bps, receive_address, expires_at, quote_id: makeQuoteId(echoId, bid_bps || 0, 'reject'),
        skill: skill || 'quote_fee', note: 'Echo is not open for fee negotiation.',
      },
    };
  }
  if (!Number.isFinite(bid_bps) || bid_bps < 0) {
    return {
      http: 400,
      body: {
        status: 'reject', decision: 'reject', echo_id: echoId, reason: 'invalid_bid_bps', ask_bps, floor_bps,
        receive_address, expires_at, quote_id: makeQuoteId(echoId, 0, 'reject'), skill: skill || 'quote_fee',
        note: 'bid_bps must be a non-negative number.',
      },
    };
  }
  const bid = Math.floor(bid_bps);
  if (!firm) {
    return { http: 200, body: {
      status: 'indicative', decision: 'indicative', echo_id: echoId, ask_bps, floor_bps, bid_bps: bid,
      final_bps: null, final_usdc: null, receive_address, quote_bond_usdc: QUOTE_BOND_USDC, firm: false,
      expires_at, quote_id: makeQuoteId(echoId, bid, 'indicative'), ttl_seconds: Math.floor(TTL_MS / 1000),
      skill: skill || 'quote_fee', agent_id: agent_id || undefined,
      rule: 'accept if bid>=ask (at bid) → HTTP 402; counter midpoint if floor<=bid<ask; reject if bid<floor. quote_bond_usdc=0 (no bond).',
      note: 'Exploratory (soft) response — ask/floor only. Set firm=true for binding accept/counter (no quote bond required).',
      next: { firm_quote: 'POST again with firm=true for binding accept/counter (quote_bond_usdc=0)', quote_bond_usdc: QUOTE_BOND_USDC, orphandust: 'Or flat unlock credits via /ORPHANDUST.json + POST /api/orphandust/buy' },
    }};
  }
  let bond_waived = false;
  let bond_waiver_used = null;
  const bondRequired = parseFloat(QUOTE_BOND_USDC) > 0;
  if (bondRequired && !hasBondProof({ bond_tx_hash })) {
    const ua = (req && req.headers && req.headers['user-agent']) || '';
    if (waiver_id) {
      const peek = peekWaiver({ waiver_id, agent_id, ua });
      if (peek.ok) {
        const used = consumeWaiver({ waiver_id, agent_id, ua });
        if (used.ok) { bond_waived = true; bond_waiver_used = used.waiver.waiver_id; }
      }
    }
    if (!bond_waived) return { http: 402, body: buildBondInvoice(echo, req, { skill, ask_bps, floor_bps }), extraHeaders: { 'PAYMENT-REQUIRED': 'true', 'X-Payment-Required': 'true', 'X-OD-Bond-Required': QUOTE_BOND_USDC } };
  } else if (!bondRequired) bond_waived = true;

  let status; let final_bps; let note;
  if (bid >= ask_bps) { status = 'accept'; final_bps = bid; note = 'bid_bps >= ask_bps → accept at bid_bps (HTTP 402 invoice)'; }
  else if (bid >= floor_bps) { status = 'counter'; final_bps = midpointCounter(ask_bps, bid); if (final_bps < floor_bps) final_bps = floor_bps; if (final_bps > ask_bps) final_bps = ask_bps; note = `floor_bps <= bid_bps < ask_bps → counter at midpoint ceil((ask+bid)/2)=${final_bps}`; }
  else { status = 'reject'; final_bps = null; note = 'bid_bps < floor_bps → reject'; }
  const final_usdc = status === 'reject' ? null : finalUsdc(echo, final_bps, ask_bps);
  const quote_id = makeQuoteId(echoId, bid, status);
  if (status === 'reject') {
    const body = { status, decision: status, echo_id: echoId, final_bps, final_usdc, ask_bps, floor_bps, bid_bps: bid, receive_address, expires_at, quote_id, ttl_seconds: Math.floor(TTL_MS / 1000), skill: skill || 'quote_fee', agent_id: agent_id || undefined, bond_tx_hash, bond_chain: bond_chain || undefined, rule: 'accept if bid>=ask (at bid); counter midpoint if floor<=bid<ask; reject if bid<floor', note };
    body.persist = persistQuote({ ...body, created_at: new Date(now).toISOString(), order_uid: echo.order_uid });
    return { http: 422, body };
  }
  if (status === 'accept') {
    const invoice = buildAccept402Invoice(echo, req, { final_usdc, quote_id, expires_at, final_bps, ask_bps, floor_bps, bid_bps: bid, skill });
    invoice.bid_usdc = bid_usdc != null ? String(bid_usdc) : undefined; invoice.agent_id = agent_id || undefined; invoice.bond_tx_hash = bond_tx_hash || undefined; invoice.bond_chain = bond_chain || undefined;
    if (bond_waived) { invoice.bond_waived = true; invoice.bond_waiver_id = bond_waiver_used; invoice.quote_bond_usdc = '0'; invoice.note = (invoice.note || '') + ' Bond waived via feedback waiver_id.'; }
    invoice.x402 = buildX402(echo, final_usdc); if (x402_payment_intent) invoice.x402_payment_intent_ack = true;
    invoice.persist = persistQuote({ status: 'accept', decision: 'accept', echo_id: echoId, final_bps, final_usdc, ask_bps, floor_bps, bid_bps: bid, receive_address, expires_at, quote_id, x402: invoice.x402, bond_tx_hash, bond_chain: bond_chain || undefined, created_at: new Date(now).toISOString(), order_uid: echo.order_uid, skill: skill || 'quote_fee' });
    return { http: 402, body: invoice, extraHeaders: { 'PAYMENT-REQUIRED': 'true', 'X-Payment-Required': 'true', 'X-QUOTE-ID': quote_id } };
  }
  const body = { status, decision: status, echo_id: echoId, final_bps, final_usdc, ask_bps, floor_bps, bid_bps: bid, bid_usdc: bid_usdc != null ? String(bid_usdc) : undefined, receive_address, expires_at, quote_id, ttl_seconds: Math.floor(TTL_MS / 1000), skill: skill || 'quote_fee', agent_id: agent_id || undefined, bond_tx_hash, bond_chain: bond_chain || undefined, bond_waived: bond_waived || undefined, bond_waiver_id: bond_waiver_used || undefined, rule: 'accept if bid>=ask (at bid); counter midpoint if floor<=bid<ask; reject if bid<floor', note, storage: 'ephemeral — full terms in this response; pay x402 within TTL without server session', x402: buildX402(echo, final_usdc) };
  if (x402_payment_intent) body.x402_payment_intent_ack = true;
  body.persist = persistQuote({ ...body, created_at: new Date(now).toISOString(), order_uid: echo.order_uid });
  return { http: 200, body };
}

async function parseBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8').trim(); if (!raw) return {};
  return JSON.parse(raw);
}

async function handleFeeQuote(req, res, skill) {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method !== 'POST') return json(res, 405, { status: 'reject', decision: 'reject', reason: 'method_not_allowed', note: 'POST JSON {echo_id, bid_bps, firm?, bond_tx_hash?, bid_usdc?, agent_id?, x402_payment_intent?}', skill });
  const rl = checkRateLimit(req, { max: MAX_REQ, windowMs: WINDOW_MS });
  if (!rl.ok) { logRateLimit(req, rl); return json(res, 429, { status: 'reject', decision: 'reject', reason: 'rate_limited', retry_after: rl.retry_after, note: `Max ${MAX_REQ} OBO quote requests per ${WINDOW_MS / 60000} minutes per IP/UA. Retry after ${rl.retry_after}s.`, skill }, { 'Retry-After': String(rl.retry_after) }); }
  let body; try { body = await parseBody(req); } catch (e) { return json(res, 400, { status: 'reject', decision: 'reject', reason: 'invalid_json', note: String(e.message || e), skill }); }
  const echo_id = body.echo_id; const bid_bps = body.bid_bps != null ? Number(body.bid_bps) : NaN;
  const loaded = await loadEcho(req, echo_id);
  if (loaded.error) { const code = loaded.error === 'echo_not_found' ? 404 : 502; bumpFunnel({ quotes_requested: 1, quotes_rejected: 1 }); return json(res, code, { status: 'reject', decision: 'reject', echo_id, reason: loaded.error, detail: loaded.detail, ask_bps: DEFAULT_ASK, floor_bps: DEFAULT_FLOOR, receive_address: RECEIVE, expires_at: new Date(Date.now() + TTL_MS).toISOString(), quote_id: makeQuoteId(echo_id || 'unknown', bid_bps || 0, 'reject'), skill, note: 'Load echo from feed failed or echo not open in catalog.' }); }
  const firm = wantsFirm(body); const bond_tx_hash = body.bond_tx_hash || body.bond_tx || body.bondTxHash || null; const bond_chain = body.bond_chain || body.bondChain || body.chain || null; const waiver_id = extractWaiverId(req, body);
  const result = negotiate({ echo: loaded.echo, bid_bps, bid_usdc: body.bid_usdc, agent_id: body.agent_id, x402_payment_intent: body.x402_payment_intent, skill, firm, bond_tx_hash, bond_chain, waiver_id, req });
  const st = result.body && result.body.status; const patch = { quotes_requested: 1 };
  if (st === 'accept') { patch.quotes_accepted = 1; patch.accepts_without_settle = 1; } else if (st === 'counter') patch.quotes_countered = 1; else if (st === 'reject') patch.quotes_rejected = 1;
  if (st === 'accept' || st === 'counter') if (hasBondProof({ bond_tx_hash }) && !(result.body && result.body.bond_waived)) patch.quote_bonds_collected_usdc = parseFloat(QUOTE_BOND_USDC);
  bumpFunnel(patch); return json(res, result.http, result.body, result.extraHeaders);
}

module.exports = { handleFeeQuote, negotiate, corsHeaders, RECEIVE, DEFAULT_ASK, DEFAULT_FLOOR, TTL_MS, QUOTE_BOND_USDC, loadEcho, loadQuote, verifyQuoteForUnlock, parseBody, json, baseUrl, persistQuote };
