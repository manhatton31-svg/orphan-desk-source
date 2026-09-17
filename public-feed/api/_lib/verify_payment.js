/**
 * On-chain ERC-20 payment verification for Orphan Desk.
 *
 * Replaces pure tx_hash attestation: fetch receipt via public RPC, confirm
 * success, decode Transfer to fee wallet, check token + amount ≥ expected.
 *
 * Preferred: USDC on Base. Also: USDT on BSC. Optional: USDC/USDT on Ethereum.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RECEIVE = '0x459cF7359e37B45A0d2a2479656cD96cdA9F7dBb';

const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Known USD-stable tokens (address lowercased → meta). */
const TOKENS = {
  // USDC on Base (6 decimals)
  '0x833589fcd6edb6e08f4c7c32d4f71b54bdA02913'.toLowerCase(): {
    asset: 'USDC',
    chain: 'base',
    chainId: 8453,
    decimals: 6,
  },
  // USDT on BSC — Binance-Peg USDT (18 decimals on-chain)
  '0x55d398326f99059ff775485246999027b3197955': {
    asset: 'USDT',
    chain: 'bsc',
    chainId: 56,
    decimals: 18,
  },
  // USDC on Ethereum (6 decimals)
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': {
    asset: 'USDC',
    chain: 'ethereum',
    chainId: 1,
    decimals: 6,
  },
  // USDT on Ethereum (6 decimals)
  '0xdac17f958d2ee523a2206206994597c13d831ec7': {
    asset: 'USDT',
    chain: 'ethereum',
    chainId: 1,
    decimals: 6,
  },
};

const CHAIN_ALIASES = {
  base: 'base',
  'base-mainnet': 'base',
  '8453': 'base',
  bsc: 'bsc',
  bnb: 'bsc',
  'bnb-chain': 'bsc',
  binance: 'bsc',
  '56': 'bsc',
  ethereum: 'ethereum',
  eth: 'ethereum',
  mainnet: 'ethereum',
  '1': 'ethereum',
};

const DEFAULT_RPCS = {
  base: [
    process.env.RPC_BASE,
    'https://mainnet.base.org',
    'https://base.publicnode.com',
    'https://base.llamarpc.com',
  ].filter(Boolean),
  bsc: [
    process.env.RPC_BSC,
    'https://bsc-dataseed.binance.org',
    'https://bsc.publicnode.com',
    'https://binance.llamarpc.com',
  ].filter(Boolean),
  ethereum: [
    process.env.RPC_ETHEREUM || process.env.RPC_ETH,
    'https://ethereum.publicnode.com',
    'https://cloudflare-eth.com',
    'https://eth.llamarpc.com',
  ].filter(Boolean),
};

const IDEMPOTENCY_SECRET =
  process.env.ORPHAN_DESK_SECRET ||
  process.env.ORPHAN_DESK_CREDIT_SECRET ||
  'orphan-desk-tx-idempotency-v1|0x459cF7359e37B45A0d2a2479656cD96cdA9F7dBb';

function normalizeChain(raw) {
  if (raw == null || raw === '') return null;
  const key = String(raw).trim().toLowerCase();
  return CHAIN_ALIASES[key] || null;
}

function normalizeAddr(a) {
  if (!a || typeof a !== 'string') return null;
  const s = a.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(s)) return null;
  return s;
}

function isHexTx(tx) {
  return typeof tx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(tx);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function rpcCall(rpcUrl, method, params, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`rpc_http_${res.status}:${text.slice(0, 120)}`);
    }
    const body = await res.json();
    if (body.error) {
      throw new Error(`rpc_error:${body.error.message || JSON.stringify(body.error)}`);
    }
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

async function rpcCallWithRetry(chain, method, params, attempts = 3) {
  const urls = DEFAULT_RPCS[chain] || [];
  if (!urls.length) {
    return { ok: false, error: `no_rpc_for_chain:${chain}` };
  }
  const errors = [];
  for (let i = 0; i < attempts; i++) {
    const url = urls[i % urls.length];
    try {
      const result = await rpcCall(url, method, params);
      return { ok: true, result, rpc: url, attempt: i + 1 };
    } catch (e) {
      errors.push(`${url}: ${String(e.message || e)}`);
      if (i < attempts - 1) await sleep(250 * (i + 1));
    }
  }
  return {
    ok: false,
    error: `rpc_unavailable_after_${attempts}_tries`,
    detail: errors.slice(0, 3),
  };
}

function topicToAddress(topic) {
  if (!topic || typeof topic !== 'string' || topic.length < 42) return null;
  return ('0x' + topic.slice(-40)).toLowerCase();
}

function hexToBigInt(hex) {
  if (!hex || typeof hex !== 'string') return 0n;
  const h = hex.startsWith('0x') ? hex : `0x${hex}`;
  if (h === '0x' || h === '0x0') return 0n;
  return BigInt(h);
}

/** Convert human decimal string (e.g. "0.25") to raw token units BigInt. */
function amountToRaw(human, decimals) {
  const s = String(human).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const raw = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, '') || '0';
  try {
    return BigInt(raw);
  } catch (_) {
    return null;
  }
}

/** Convert raw BigInt to human decimal string (trimmed). */
function rawToHuman(raw, decimals) {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const s = v.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals) || '0';
  let frac = s.slice(s.length - decimals);
  frac = frac.replace(/0+$/, '');
  const out = frac ? `${whole}.${frac}` : whole;
  return neg ? `-${out}` : out;
}

function consumedDirs() {
  return [
    '/tmp/orphan-desk-consumed-txs',
    path.join(process.cwd(), 'consumed-txs'),
    path.join(process.cwd(), 'public-feed', 'consumed-txs'),
  ];
}

function txKey(txHash) {
  return String(txHash).toLowerCase();
}

function isTxConsumed(txHash) {
  const key = txKey(txHash);
  const name = `tx_${key.slice(2)}.json`;
  for (const dir of consumedDirs()) {
    try {
      const fp = path.join(dir, name);
      if (fs.existsSync(fp)) {
        try {
          return { consumed: true, record: JSON.parse(fs.readFileSync(fp, 'utf8')), path: fp };
        } catch (_) {
          return { consumed: true, record: null, path: fp };
        }
      }
    } catch (_) {}
  }
  // Also scan settle receipts for same tx_hash (best-effort)
  const receiptRoots = [
    '/tmp/orphan-desk-receipts',
    '/tmp/orphan-desk-settles',
    path.join(process.cwd(), 'receipts'),
    path.join(process.cwd(), 'public-feed', 'receipts'),
  ];
  for (const root of receiptRoots) {
    try {
      if (!fs.existsSync(root)) continue;
      const files = fs.readdirSync(root).filter((f) => f.endsWith('.json'));
      for (const f of files) {
        try {
          const obj = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
          const th =
            (obj.tx_hash && String(obj.tx_hash).toLowerCase()) ||
            (obj.fee && obj.fee.tx_hash && String(obj.fee.tx_hash).toLowerCase()) ||
            null;
          if (th === key) {
            return {
              consumed: true,
              record: { receipt_id: obj.receipt_id, source: path.join(root, f) },
              path: path.join(root, f),
            };
          }
        } catch (_) {}
      }
    } catch (_) {}
  }
  return { consumed: false };
}

function signIdempotencyNote(payload) {
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', IDEMPOTENCY_SECRET).update(body).digest('hex').slice(0, 32);
  return { ...payload, sig: `odtx_${sig}` };
}

function markTxConsumed(txHash, meta) {
  const key = txKey(txHash);
  const record = signIdempotencyNote({
    tx_hash: key,
    consumed_at: new Date().toISOString(),
    ...(meta || {}),
  });
  const name = `tx_${key.slice(2)}.json`;
  const wrote = [];
  for (const dir of consumedDirs()) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const fp = path.join(dir, name);
      fs.writeFileSync(fp, JSON.stringify(record, null, 2) + '\n');
      wrote.push(fp);
    } catch (_) {}
  }
  return { record, wrote };
}

/**
 * Verify an on-chain ERC-20 Transfer payment.
 *
 * @param {object} opts
 * @param {string} opts.tx_hash
 * @param {string} opts.chain - base|bsc|ethereum
 * @param {string} [opts.asset] - USDC|USDT (optional; inferred from Transfer token)
 * @param {string|number} opts.expected_amount - human USD-stable amount
 * @param {string} [opts.pay_to] - defaults to fee wallet
 * @returns {Promise<{ok:boolean, amount?, asset?, chain?, from?, to?, token?, raw_amount?, rpc?, error?, detail?}>}
 */
async function verifyPayment(opts) {
  const txHash = opts && (opts.tx_hash || opts.txHash);
  const chainIn = opts && (opts.chain || opts.network);
  const assetHint = opts && opts.asset ? String(opts.asset).trim().toUpperCase() : null;
  const expectedAmount = opts && (opts.expected_amount != null ? opts.expected_amount : opts.amount);
  const payTo = normalizeAddr((opts && (opts.pay_to || opts.payTo || opts.receive)) || RECEIVE);

  if (!txHash || !isHexTx(txHash)) {
    return { ok: false, error: 'invalid_tx_hash', detail: 'tx_hash must be 0x-prefixed 32-byte hex' };
  }
  const chain = normalizeChain(chainIn);
  if (!chain) {
    return {
      ok: false,
      error: 'unsupported_chain',
      detail: 'chain must be base|bsc|ethereum (aliases: eth, bnb, 8453, 56, 1)',
    };
  }
  if (expectedAmount == null || !Number.isFinite(parseFloat(expectedAmount)) || parseFloat(expectedAmount) <= 0) {
    return { ok: false, error: 'invalid_expected_amount', detail: 'expected_amount must be a positive decimal' };
  }
  if (!payTo) {
    return { ok: false, error: 'invalid_pay_to' };
  }

  // Fail closed on reused tx (best-effort)
  const prior = isTxConsumed(txHash);
  if (prior.consumed) {
    return {
      ok: false,
      error: 'tx_already_consumed',
      detail: prior.record || { path: prior.path },
      chain,
    };
  }

  const receiptRes = await rpcCallWithRetry(chain, 'eth_getTransactionReceipt', [txHash], 3);
  if (!receiptRes.ok) {
    return {
      ok: false,
      error: receiptRes.error || 'rpc_unavailable',
      detail: receiptRes.detail,
      chain,
    };
  }
  const receipt = receiptRes.result;
  if (!receipt) {
    return {
      ok: false,
      error: 'tx_not_found',
      detail: 'Receipt null — tx not mined or wrong chain',
      chain,
      rpc: receiptRes.rpc,
    };
  }
  if (receipt.status !== '0x1' && receipt.status !== 1 && receipt.status !== '0x01') {
    return {
      ok: false,
      error: 'tx_failed',
      detail: `receipt.status=${receipt.status}`,
      chain,
      rpc: receiptRes.rpc,
    };
  }

  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const matches = [];
  for (const log of logs) {
    const topics = log.topics || [];
    if (!topics.length || String(topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
    const tokenAddr = normalizeAddr(log.address);
    const meta = tokenAddr && TOKENS[tokenAddr];
    if (!meta) continue;
    if (meta.chain !== chain) continue;
    const to = topicToAddress(topics[2]);
    if (!to || to !== payTo) continue;
    const from = topicToAddress(topics[1]);
    const raw = hexToBigInt(log.data);
    matches.push({ tokenAddr, meta, from, to, raw });
  }

  if (!matches.length) {
    return {
      ok: false,
      error: 'no_matching_transfer',
      detail: `No ERC-20 Transfer of known USDC/USDT to ${payTo} on ${chain}`,
      chain,
      rpc: receiptRes.rpc,
    };
  }

  // Prefer asset hint if provided; else take largest matching transfer
  let chosen = null;
  if (assetHint) {
    chosen = matches.find((m) => m.meta.asset === assetHint) || null;
    if (!chosen) {
      return {
        ok: false,
        error: 'asset_mismatch',
        detail: `No ${assetHint} Transfer to fee wallet; found ${matches.map((m) => m.meta.asset).join(',')}`,
        chain,
        rpc: receiptRes.rpc,
      };
    }
  } else {
    chosen = matches.reduce((a, b) => (b.raw > a.raw ? b : a));
  }

  const expectedRaw = amountToRaw(expectedAmount, chosen.meta.decimals);
  if (expectedRaw == null) {
    return { ok: false, error: 'invalid_expected_amount', detail: 'could not parse expected_amount' };
  }
  if (chosen.raw < expectedRaw) {
    return {
      ok: false,
      error: 'amount_insufficient',
      detail: {
        got: rawToHuman(chosen.raw, chosen.meta.decimals),
        expected: String(expectedAmount),
        decimals: chosen.meta.decimals,
        token: chosen.tokenAddr,
      },
      chain,
      asset: chosen.meta.asset,
      amount: rawToHuman(chosen.raw, chosen.meta.decimals),
      from: chosen.from,
      to: chosen.to,
      rpc: receiptRes.rpc,
    };
  }

  // Soft asset/chain consistency: preferred pairs
  // (USDC+base, USDT+bsc, USDC|USDT+ethereum) — already enforced by TOKENS map

  return {
    ok: true,
    amount: rawToHuman(chosen.raw, chosen.meta.decimals),
    asset: chosen.meta.asset,
    chain,
    from: chosen.from,
    to: chosen.to,
    token: chosen.tokenAddr,
    decimals: chosen.meta.decimals,
    raw_amount: chosen.raw.toString(),
    tx_hash: txKey(txHash),
    rpc: receiptRes.rpc,
    block_number: receipt.blockNumber || null,
    verified_at: new Date().toISOString(),
  };
}

/**
 * Verify then mark consumed. Use after business checks pass but before issuing
 * credits / unlocking. If mark fails, still returns verify ok (best-effort).
 */
async function verifyAndConsume(opts, consumeMeta) {
  const verified = await verifyPayment(opts);
  if (!verified.ok) return verified;
  const marked = markTxConsumed(verified.tx_hash || opts.tx_hash, {
    ...(consumeMeta || {}),
    asset: verified.asset,
    chain: verified.chain,
    amount: verified.amount,
    from: verified.from,
    to: verified.to,
    token: verified.token,
  });
  return {
    ...verified,
    idempotency: marked.record,
    consumed_paths: marked.wrote,
  };
}

module.exports = {
  RECEIVE,
  TOKENS,
  DEFAULT_RPCS,
  TRANSFER_TOPIC,
  verifyPayment,
  verifyAndConsume,
  isTxConsumed,
  markTxConsumed,
  normalizeChain,
  isHexTx,
  amountToRaw,
  rawToHuman,
};
