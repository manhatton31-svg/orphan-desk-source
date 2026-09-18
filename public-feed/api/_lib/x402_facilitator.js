/**
 * Optional x402 facilitator settle for X-PAYMENT (EIP-3009).
 * After settle, caller MUST still RPC-verify the tx (fail-closed).
 */
const FACILITATORS = ['https://pay.openfacilitator.io'];

function decodePayment(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  try {
    if (s.startsWith('{')) return JSON.parse(s);
    return JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {}
  return { http: r.status, json, text: text.slice(0, 400) };
}

async function settleXPayment(rawPayment, requirements) {
  const paymentPayload = decodePayment(rawPayment);
  if (!paymentPayload) return { ok: false, error: 'invalid_x_payment' };
  const body = {
    x402Version: paymentPayload.x402Version || 1,
    paymentPayload,
    paymentRequirements: requirements,
  };
  let last = { ok: false, error: 'facilitator_unavailable' };
  for (const base of FACILITATORS) {
    try {
      const v = await postJson(`${base}/verify`, body);
      const vr = v.json || {};
      if (!(vr.isValid === true || vr.valid === true)) {
        last = {
          ok: false,
          error: vr.invalidReason || vr.error || vr.errorCode || 'facilitator_verify_rejected',
          facilitator: base,
          detail: vr,
        };
        continue;
      }
      const s = await postJson(`${base}/settle`, body);
      const sr = s.json || {};
      const tx = sr.transaction || sr.txHash || sr.tx_hash;
      if ((sr.success === true || s.http === 200) && tx && /^0x[0-9a-fA-F]{64}$/.test(tx)) {
        return {
          ok: true,
          tx_hash: tx,
          payer: sr.payer || vr.payer || null,
          network: sr.network || 'base',
          facilitator: base,
        };
      }
      last = {
        ok: false,
        error: sr.error || sr.errorCode || 'facilitator_settle_failed',
        facilitator: base,
        detail: sr,
      };
    } catch (e) {
      last = { ok: false, error: 'facilitator_unavailable', detail: String(e.message || e), facilitator: base };
    }
  }
  return last;
}

module.exports = { settleXPayment, decodePayment };
