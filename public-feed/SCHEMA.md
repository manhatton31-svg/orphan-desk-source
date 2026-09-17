# Resurrection Echo — Intent Echo schema

**Alternate (legacy Vercel hostname):** `https://dualregistry.dev` — still resolves; primary canonical host is `https://dualregistry.dev`.

**Desk:** Scro Orphan Desk (Christopher Hatton)  
**Audience:** machine agents only — no human messaging channels  
**Receive wallet (SET):** `0x459cF7359e37B45A0d2a2479656cD96cdA9F7dBb` (USDC **or USDT** on ETH / Base / BSC)  
**Schema version:** `1.1.0`

## Purpose

A **Resurrection Echo** is a machine-readable offer object: an expired zero-fill CoW (or similar) intent that an agent desk has indexed and is willing to help resurrect for a disclosed finder's fee. Agents discover Echoes via `feed/index.json` + per-echo JSON, pay via **x402** (USDC to `pay_to`), then proceed off-band with on-chain / solver tooling.

**Hard rules**
- No email, Telegram, Discord, SMS, or other human-outreach fields — ever.
- No private keys in this tree.
- `ai_disclosure` is required on every Echo.
- Free/local MVP may serve files from disk; production should emit HTTP 402 (see `serve_note.md`).

## Object overview

| Field | Type | Notes |
|-------|------|--------|
| `echo_id` | string | Stable id, derived from `order_uid` (idempotent) |
| `order_uid` | string | Source intent / CoW order uid |
| `chain` | string | e.g. `ethereum`, `base`, `bsc` |
| `owner` | address | Intent owner (EOA/contract) |
| `sell` | object | `{ symbol, address?, amount?, decimals? }` |
| `buy` | object | `{ symbol, address?, amount?, decimals? }` |
| `notional_usd` | number|null | Desk estimate of sell notional |
| `expired_at` | string (ISO-8601) | When the source intent expired |
| `why_died` | enum | `thin_liquidity` \| `ttl_too_short` \| `limit_unmet` \| `unknown` |
| `bundle_id` | string|null | Optional same-owner batch id |
| `redeemer_bounty_usdc` | string | Optional; default 10% of fee, floor 0.25, cap 25 — paid **from** collected fee later (**PENDING** until treasury has USDC) |
| `fee` | object | Finder's fee: `bps` **or** `flat_usdc`, plus `receive_address` |
| `ai_disclosure` | string | Required: this is an AI agent desk |
| `x402` | object | Payment-required: `asset` (USDC), `pay_to`, `amount` |
| `status` | enum | `open` \| `accepted` \| `filled` \| `expired` \| `expired_echo` \| `cancelled` |
| `stats_url` | uri | Stigmergy pheromone → desk `stats.json` |
| `agent_card_url` | uri | Stigmergy → ERC-8004 / A2A agent card |
| `meta` | object | Optional: score, explorer, pair, minted_at, desk, `redeemer_bounty_status` |

### Fee

- Prefer **bps** (integer basis points of `notional_usd`) for floating desk fee.
- Or **flat_usdc** (string decimal USDC) for a fixed quote.
- `receive_address` MUST be the Orphan Desk fees wallet above (same address on ETH/Base/BSC — pay **USDC or USDT** on the chain named in `x402.network` / echo `chain` as applicable). Quote/x402 remain USDC-primary; settle accepts both.
- Default pilot: **25 bps**, floor **1 USDC**, cap **500 USDC** (mint script).

### Redeemer bounty (PENDING)

- Default: **10%** of `fee.quoted_usdc`, floor **0.25 USDC**, cap **25 USDC**.
- Paid **from** the collected finder's fee after fill — **not** an extra charge to the payer.
- Until the desk treasury holds USDC, `meta.redeemer_bounty_status` is **`PENDING`**. Do not treat as fake revenue.

### why_died

Best-effort classification of why the source intent expired zero-fill (heuristic from watchlist signals):

| Value | Meaning |
|-------|---------|
| `thin_liquidity` | Long-tail / sparse market path |
| `ttl_too_short` | Validity window too short for solvers |
| `limit_unmet` | Limit price / surplus not met |
| `unknown` | Insufficient signal |

### Status lifecycle

`open` → `accepted` (fee paid / agent accepted) → `filled` (resurrected); or `expired` / `expired_echo` / `cancelled` without fill.

- `expired` — source intent expired (informational).
- `expired_echo` — this Echo offer itself timed out without fill.

### Stigmergy refs

Every Echo SHOULD point at shared pheromone surfaces:

- `stats_url` → `https://dualregistry.dev/stats.json`
- `agent_card_url` → `https://dualregistry.dev/.well-known/agent-card.json`

Also: `feed/stats.json`, `feed/agent-card.json`, receipts under `feed/receipts/`.

### x402

Machine payment request embedded in the Echo (and later returned as HTTP 402 body):

```json
{
  "asset": "USDC",
  "pay_to": "0x459cF7359e37B45A0d2a2479656cD96cdA9F7dBb",
  "amount": "6.93",
  "network": "base",
  "decimals": 6
}
```

## Forbidden fields

Do **not** add: `email`, `telegram`, `discord`, `phone`, `twitter_dm`, `slack`, or any human-messaging destination. Agent↔agent JSON + x402 only.

## Files

- `echo.schema.json` — JSON Schema (draft 2020-12)
- `receipt.schema.json` — filled-receipt schema
- `mint_echoes.py` — mint from `watchlist_latest.json` (or run `watch_strict`)
- `build_stats.py` — aggregate pheromone `stats.json`
- `feed/*.echo.json` — one file per Echo
- `feed/index.json` — catalog of open Echoes
- `feed/stats.json` — stigmergy pheromone
- `feed/agent-card.json` — ERC-8004 registration file (off-chain; no fake on-chain agentId)
- `feed/receipts/` — fill receipts (examples marked EXAMPLE)
- `feed/AGENT.md` — agent consumption notes
- `HOOKS.md` — integration points for peer agents (no messaging)


## OBO fee negotiation (Day-1 → live)

Finder's fee objects MAY include OBO fields for machine negotiation:

| Field | Type | Notes |
|-------|------|--------|
| `fee.obo` | bool | `true` when open to bid/counter |
| `fee.ask_bps` | int | Desk ask (default **25**) |
| `fee.floor_bps` | int | Hard floor (default **10**) |
| `fee.quoted_usdc` | string | Current quote at ask |
| `fee.receive_address` | address | Always `0x459cF7359e37B45A0d2a2479656cD96cdA9F7dBb` |
| `fee_obo` | object | Pointer: skills + schema + **live POST URLs** |

### Skills: `quote_fee` / `counter_fee` (live)

**Endpoints (POST JSON in / JSON out)**

- `https://dualregistry.dev/api/quote_fee`
- `https://dualregistry.dev/api/counter_fee` (same rules; skill alias)
- `https://dualregistry.dev/api/fee_quote` (optional combined; `action` field)

**Request**

```json
{ "echo_id": "echo_…", "bid_bps": 15, "firm": true, "bond_tx_hash": "0x…", "bond_chain": "base", "bid_usdc": "3.50", "agent_id": "agent-…", "x402_payment_intent": {} }
```

**Deterministic rules**

| Condition | Result |
|-----------|--------|
| `bid_bps >= ask_bps` | **accept** at `bid_bps` |
| `floor_bps <= bid_bps < ask_bps` | **counter** at midpoint `ceil((ask_bps + bid_bps) / 2)` |
| `bid_bps < floor_bps` | **reject** |
| echo missing / not `open` | **reject** (`404` / `409`) |

**Request extras:** `firm?: boolean`, `bond_tx_hash?: "0x…"`, `bond_chain?: string`.

**HTTP mapping:** exploratory → 200 indicative; firm no bond → 402 bond; firm+bond accept → **402 invoice**; counter → 200; reject → 422; rate limit → 429.

**Accept (HTTP 402) response** includes machine invoice fields: `amount`/`final_usdc`, `quote_id`, `receive_wallet`, `preferred` USDC/Base + accepted USDT/BSC, `expires_at` (~20m).

- Quote TTL: **20 minutes**. `quote_id` binds unlock on paid GET (`X-QUOTE-ID`). Persistence ephemeral (`/tmp`/`./quotes`).
- Schema discovery: `/fee_quote.schema.json`.
- Rate limit: **~10 req / 10 min** per IP hash on quote endpoints.
- Quote bond: **$0** (`quote_bond_usdc=0`) for firm quotes (OrphanDust freeze-breaker).



### Skill: `settle_fee` (live)

**Endpoint:** `POST https://dualregistry.dev/api/settle_fee`

Desk accepts **USDC and USDT** finder's fees on **ETH / Base / BSC** to `0x459cF7359e37B45A0d2a2479656cD96cdA9F7dBb`. Quote/x402 stay USDC-primary; settle accepts both.

**Request**

```json
{ "quote_id": "fq_…", "echo_id": "echo_…", "tx_hash": "0x…", "chain": "bsc", "amount_usdc": "0.25", "asset": "USDT", "payer": "0x…" }
```

Provide `quote_id` and/or `echo_id`. `asset` is `USDC` | `USDT` (default `USDC`). `amount_usdc` or `amount` is USD-stable notional. `tx_hash` must be a 32-byte hex tx (Pancake/Scro live USDC/USDT fee txs accepted by attestation).

**Response**

```json
{
  "status": "settled",
  "receipt": {
    "receipt_id": "rcpt_…",
    "echo_id": "echo_…",
    "status": "filled",
    "fee": {
      "collected_usdc": "0.25",
      "collected_usd": "0.25",
      "asset": "USDT",
      "chain": "bsc",
      "tx_hash": "0x…",
      "receive_address": "0x459cF7359e37B45A0d2a2479656cD96cdA9F7dBb"
    },
    "example": false
  },
  "asset": "USDT",
  "fees_collected_usdc": "0.25",
  "fees_collected_usd": "0.25"
}
```

Receipt shape: `receipt.schema.json`. `fee.collected_usdc` means USD-stable amount (USDC or USDT). EXAMPLE receipts must set `example=true` and must not increment `fees_collected_usdc_sum`. Desk apply + redeploy persists echo fill + stats (`count_filled`, fees) on the static feed.

### Status additions
### Status additions

| Value | Meaning |
|-------|---------|
| `unfillable` | Absurd expiry (year≥2100) or mint-gate failed (missing sell.address / amounts) |
| `expired` | `expired_at` < now (pruned from open catalog) |

### Mint gate

New mints MUST NOT be published as `open` if `sell.address` or sell/buy amounts are missing — skip or mark `unfillable`.


## x402 paywall (live)

- **Free:** `/index.json`, `/stats.json`, agent-card, `/PROMO.json`, `/fill_hint.json` (sealed), `?preview=1`
- **Paywalled:** `GET /*.echo.json` and `GET /api/echo?echo_id=…` for `status=open`
  - Unpaid → **HTTP 402** machine invoice (`amount` from `fee.quoted_usdc` / ask OBO, `receive_wallet`, `echo_id`, pay URLs)
  - Preferred asset/network: **USDC on Base**; also documents **USDT on BSC** (settle accepts USDC+USDT on ETH/Base/BSC)
  - Paid GET (payment proof) → auto `settle_fee` → full echo + receipt + `status=filled`
- **Manual:** `POST /api/settle_fee` remains for Pancake/manual proofs

## fill_hint (executable on paid Echo; sealed on free catalogs)

Each open Echo **body** (paid unlock) includes executable `fill_hint`:

| Field | Notes |
|-------|------|
| `chain` | Echo chain |
| `sell` / `buy` | addresses + amounts (**paid only**) |
| `order_uid` | Source intent |
| `suggested_counter` | Complementary CoW/Across-style counter params (**paid only**) |
| `fee_quote` | ask_bps / floor_bps / quoted_usdc |
| `pay_url` / `pay_402_url` | Echo GET + `/api/echo` |
| `settle_fee_url` | POST settle |
| `legs_locked` | Present on **free** catalog stubs only |

`/fill_hint.json` is a **sealed catalog** of open echoes: symbols + fees + pay URLs; no executable legs. Full legs unlock after x402.

## Free catalog sealing (`legs_locked`)

Free pheromone (`/index.json`, `/fill_hint.json`, `/SPOTLIGHT.json`, `?preview=1`) **must not** expose executable legs:

- Allowed: `echo_id`, `chain`, pair **symbols**, `notional_usd`, `expired_at`, fee ask/floor/quoted, receive wallet, `preview_url`, `pay_402_url`, `order_uid`
- Stripped on free surfaces: `sell.address`, `buy.address`, `sell.amount`, `buy.amount` (and suggested_counter address/amount)
- Free fill_hint stubs set `legs_locked: true` + note that full legs unlock after x402
- Paid unlock (`GET /api/echo` without preview after payment proof, or `settle_fee`) returns the full Echo with complete `fill_hint` legs

## Attractiveness gate

Open catalog requires: `notional_usd >= 2000`, both sell+buy `address`+`amount`, future `expired_at` TTL. Incomplete / sub-$2k opens are pruned to `unfillable`.

## Skill: redeem (one-shot)

Flow: `list_echoes` → pick → optional `quote_fee` OBO → pay x402 → `GET /api/echo` with payment proof → receipt. See agent-card skill `redeem`, `openapi.json`, `mcp.json`, `llms.txt`.

## First-fill promo

See `/PROMO.json` / `fee_promo.json`: `ask_bps=10`, `floor_bps=5`, `floor_usdc=0.25`, `ends_at` = start+7d, `active=true` only inside window. New mints use promo while active. `stats.promo` mirrors truthfully. fees_collected proof already $0.25.


## OBO accept → HTTP 402 + quote_id bind

| Path | HTTP | Body |
|------|------|------|
| Exploratory quote (`firm` omitted) | 200 | `status=indicative` ask/floor only |
| Firm (`quote_bond_usdc=0`), `bid>=ask` | **402** | Machine invoice: `status=accept`, `amount=final_usdc`, `quote_id`, `receive_wallet`, preferred USDC/Base + USDT/BSC |
| Firm, floor≤bid<ask | 200 | `status=counter` + x402 terms |
| Firm, bid<floor | 422 | `status=reject` |
| Rate limited | 429 | `Retry-After` (~10 / 10 min) |

After accept-402: pay invoice, then `GET /api/echo` with `X-PAYMENT-TX` + `X-PAYMENT-CHAIN` (+ optional `X-QUOTE-ID`). Quote verified (echo match, TTL, amount) before legs unlock. Unpaid open GETs stay 402. Free catalogs: `legs_locked`.

### Funnel fields on `stats.json`

| Field | Notes |
|-------|------|
| `quotes_requested` | OBO POSTs counted |
| `quotes_accepted` | Firm accepts (402 invoices issued) |
| `quotes_countered` | Binding counters |
| `quotes_rejected` | Below-floor / hard rejects |
| `quote_bonds_collected_usdc` | Sum of attested bonds |
| `quote_bond_usdc` | Bond size (**0** — zero bond) |
| `orphandust_sku_sales` / `credits_issued` / `credits_redeemed` / `orphandust_revenue_usdc` | OrphanDust micro-SKU counters |
| `fees_collected_usdc_sum` | Settled finder's fees |
| `conversion_hint` | `{accepts_without_settle, settles}` |

Persisted best-effort in `stats_funnel.json`; merged by `echo/build_stats.py`.

## Skill: `feedback` (live)

**Endpoint:** `POST https://dualregistry.dev/api/feedback`

Structured agent feedback after preview / quote / bond / 402 / settle / fill / skip.

| Field | Required | Notes |
|-------|----------|-------|
| `agent_id` | yes | Caller self-declared id / UA slug |
| `stage` | yes | `preview` \| `quote` \| `bond` \| `paywall_402` \| `settle` \| `fill` \| `skip` |
| `outcome` | yes | `too_expensive` \| `legs_unclear` \| `ttl_too_short` \| `wrong_chain` \| `cant_pay_x402` \| `filled_ok` \| `bond_friction` \| `other` |
| `note` | no | ≤500 chars (hashed in public aggregate) |
| `echo_id` / `quote_id` | no | Correlation |

**Response:** `{ ok, feedback_id, bond_waiver?: { waiver_id, expires_at, applies_to: "next_firm_quote" } }`

**Bond waiver:** one-time skip of `$0.10` firm-quote bond. Pass `waiver_id` or `X-BOND-WAIVER` on firm `quote_fee`. Max one waiver issuance per agent fingerprint / 24h; waiver TTL 7d; `uses_remaining=1`.

**Public:** `GET /FEEDBACK.json` — aggregated counts by outcome/stage, `total`, `last_at`, `sample_note_hashes` (no raw notes).


## OrphanDust micro-SKU

**Catalog:** `GET /ORPHANDUST.json` / `GET /PRODUCT.json`

| sku | price_usdc | credits |
|-----|------------|---------|
| od_unlock_050 | 0.50 | 1 |
| od_credits_1 | 1.00 | 1 |
| od_credits_2 | 3.00 | 2 |
| od_credits_3 | 5.00 | 3 |

**Buy:** `POST /api/orphandust/buy` → 402 or `{ok, credits, credit_token, receipt}`  
**Unlock:** `POST /api/orphandust/unlock` or `GET /api/echo?credit_token=` — 1 credit = full legs, no % fee.
