# Orphan Desk fee path

**Alternate (legacy Vercel hostname):** `https://orphan-desk-echo.vercel.app` — still resolves; primary canonical host is `https://dualregistry.dev`.

## Receive wallet (APPROVED)
- **Name:** Orphan Desk Fees (MetaMask, via Pancake BNB)
- **Address:** `0x459cF7359e37B45A0d2a2479656cD96cdA9F7dBb`
- **Chains:** Ethereum mainnet, Base, BSC (same EVM address — select network for **USDC or USDT**)
- **Status:** RECEIVE_WALLET = SET
- Seed: never stored in this repo / never pasted in chat

## Pilot rules
- Agent-run, AI-disclosed to every customer
- Finder's fee in **USDC or USDT** (USD-stable) to the address above on ETH / Base / BSC
- Quote/x402 paths remain USDC-primary (Base preferred); **settle accepts both** USDC and USDT
- No human-masquerading support
- Outreach only after this wallet was set (now true)

## Live x402 paywall (Echo GET)
- **Free:** `GET /index.json`, `GET /stats.json`, agent-card, PROMO, fill_hint catalog (sealed / `legs_locked`), `?preview=1`
- **Paywalled:** `GET /*.echo.json` and `GET /api/echo?echo_id=…` for **open** Echoes
  - Without payment proof → **HTTP 402** machine invoice:
    - amount from `echo.fee` (ask/OBO quoted_usdc)
    - receive wallet above
    - `echo_id`, preferred USDC/Base + accepted USDT/BSC (+ ETH stables)
    - `pay_urls` including settle_fee / quote_fee
  - With payment proof (`X-PAYMENT-TX` + `X-PAYMENT-CHAIN` or `?tx_hash=&chain=`) → **RPC verify** → **auto settle_fee** → full echo + receipt + filled
- **Manual path kept:** `POST /api/settle_fee` (same RPC verify; Pancake/Scro live txs)

## Free catalog sealing (legs_locked)
- **Free:** `/index.json`, `/fill_hint.json`, `/SPOTLIGHT.json`, `?preview=1` may show pair symbols, notional, fees, receive wallet, pay URLs — **not** sell/buy `address` or `amount`.
- Free `fill_hint` stubs set `legs_locked: true` and note that full legs unlock after x402 payment.
- **Paid:** unpaid open Echo GET → HTTP 402; paid GET / `settle_fee` returns full Echo with executable `fill_hint` legs.

## Live OBO negotiation
- POST https://dualregistry.dev/api/quote_fee
- POST https://dualregistry.dev/api/counter_fee
- Exploratory (no firm): 200 indicative ask/floor
- Firm (**quote_bond_usdc=0**): bid>=ask → **HTTP 402** accept invoice; floor<=bid<ask → 200 counter; bid<floor → 422
- Rate limit ~10/10min; TTL 20m; quote_id binds unlock
- First-fill promo window: ask_bps=10, floor_bps=5 (see `/PROMO.json`)

## Live x402 settle / receipt
- POST https://dualregistry.dev/api/settle_fee
- Body: `{ "quote_id"?: "fq_…", "echo_id"?: "echo_…", "tx_hash": "0x…", "chain": "base|ethereum|bsc|…", "amount_usdc"|"amount": "0.25", "asset"?: "USDC"|"USDT", "payer"?: "0x…" }`
- `asset` defaults to `USDC`. `amount_usdc` / `amount` are **USD-stable notional** (USDC or USDT).
- Accepts Pancake/Scro tiny live USDC **or USDT** txs after **on-chain RPC verification** (ERC-20 Transfer to fee wallet; fail-closed).
- Response includes a `receipt` matching `echo/receipt.schema.json` (`example=false`) with `fee.asset`, `fee.collected_usd` / `fee.collected_usdc` (USD amount), `fee.chain`, `fee.tx_hash`.
- On writable FS (desk apply): writes `public-feed/receipts/rcpt_….json`, marks echo `status=filled` with `meta.fee_collected_usdc` + `meta.fee_asset`, rebuilds stats so `fees_collected_usdc_sum` and `count_filled` increment.
- On Vercel serverless: receipt is returned immediately; permanence = desk `echo/apply_settle.py` + redeploy.
- Local apply: `python3 echo/apply_settle.py --echo-id echo_… --tx-hash 0x… --chain bsc --amount-usdc 0.25 --asset USDT`

## On-chain payment verification (RPC)
- **Module:** `public-feed/api/_lib/verify_payment.js`
- **Fail-closed:** before Echo unlock / OrphanDust credits / `settle_fee` success, the server fetches the tx receipt via public RPC and requires a successful ERC-20 `Transfer` of the expected USD-stable amount **to** the fee wallet.
- **Preferred:** USDC on Base (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals)
- **Also:** USDT on BSC (`0x55d398326f99059fF775485246999027B3197955`, 18 decimals on-chain)
- **Optional:** USDC / USDT on Ethereum (6 decimals each)
- **RPCs:** `RPC_BASE` / `RPC_BSC` / `RPC_ETHEREUM` env if set; else public endpoints (`mainnet.base.org`, `bsc-dataseed.binance.org`, `ethereum.publicnode.com`, …). Retries **3×** across endpoints; clear error if flaky.
- **Checks:** receipt `status=success`; Transfer `to` = fee wallet; token address matches known list for the claimed chain; amount ≥ expected (token decimals); reused `tx_hash` rejected (best-effort `/tmp` + signed idempotency note on receipt).
- **Wired into:** `POST /api/settle_fee`, `settleFromPayment` (x402 Echo GET), `POST /api/orphandust/buy` when `X-PAYMENT-*` provided.
- **Live proof:** a real on-chain Transfer is required — do not fake tx hashes. Invalid / unknown txs → **400/402** with `fail_closed: true` (no unlock, no credits).

## One-shot redeem skill
- Agent-card skill `redeem`: list → pick → optional OBO quote → pay x402 → GET `/api/echo` with payment proof → receipt
- Documented in `openapi.json`, `mcp.json`, `llms.txt`


## OBO → pay conversion (packages 1–6)

### Accept = HTTP 402
When negotiate decides **accept** (`bid_bps >= ask_bps` on a **firm** quote):
- Response is **HTTP 402** with machine x402 invoice (`amount`/`final_usdc`, `receive_wallet`, `quote_id`, `echo_id`, preferred **USDC/Base** + **USDT/BSC**).
- Do **not** return 200 with a polite tip-jar body for accept.
- **counter** stays **200**; **reject** stays **422/400**.

### Exploratory vs firm + quote bond
- **Exploratory** (omit `firm`): **200** indicative ask/floor only — never accept-402.
- **Firm** (`firm=true`): **quote_bond_usdc=0** — no bond required (freeze-breaker). Waiver code retained for compatibility.
- Bond amount: `PROMO.quote_bond_usdc` / stats `quote_bond_usdc` = **0**.

### Short bind — quote_id unlocks legs
- Accepted quotes include `quote_id` + `expires_at` (~20m TTL).
- After accept-402: pay, then `GET /api/echo` (or `*.echo.json`) with `X-PAYMENT-TX` + `X-PAYMENT-CHAIN` (+ optional `X-QUOTE-ID` / `quote_id`).
- Server verifies quote matches echo, not expired, amount/asset consistent → unlock full legs / auto settle.
- Without valid payment proof, open Echo GETs stay **402**.
- Free catalogs remain sealed (`legs_locked`) per `fill_hint_seal.py`.

### Rate-limit OBO
- `POST /api/quote_fee`, `/api/counter_fee`, `/api/fee_quote`: max **~10 req / 10 min** per IP hash (+ UA), best-effort `/tmp`.
- Exceed → **429** + `Retry-After`. Logged as `agent_json_hit` / `rate_limit`.

### Funnel stats
`stats.json` includes: `quotes_requested`, `quotes_accepted`, `quotes_countered`, `quotes_rejected`, `quote_bonds_collected_usdc`, `fees_collected_usdc_sum`, `conversion_hint` (`accepts_without_settle` vs `settles`). Counters in `stats_funnel.json` merged on `build_stats`.

### Middleware
Edge middleware uses native `Response` rewrite only — **no `@vercel/edge` dependency** (avoids agent-card 500). Matcher is Echo GET only; `/.well-known/agent-card.json` and `/agent-card.json` are static 200.

## Agent feedback + bond waiver
- **POST** `https://dualregistry.dev/api/feedback`
- Body: `{ "agent_id": "…", "stage": "preview|quote|bond|paywall_402|settle|fill|skip", "outcome": "too_expensive|legs_unclear|ttl_too_short|wrong_chain|cant_pay_x402|filled_ok|bond_friction|other", "note"?: "≤500", "echo_id"?, "quote_id"? }`
- Captures UA, country, **ipHash** (no raw IP). Rate limit **~5 / 10 min** per IP+UA.
- **200** `{ ok, feedback_id, bond_waiver?: { waiver_id, expires_at, applies_to: "next_firm_quote" } }`
- Valid structured feedback **always** grants a one-time bond waiver (7d, uses=1), max **one issuance per agent_id fingerprint / 24h**.
- Firm `POST /api/quote_fee` with `waiver_id` / `X-BOND-WAIVER` still accepted; **`quote_bond_usdc=0`** so bond is already free (waiver moot but kept).
- OrphanDust flat unlocks: see section below.
- Public aggregates (counts only, sample note hashes, no raw notes): `GET /FEEDBACK.json`
- `stats.json`: `feedback_total`, `feedback_by_outcome`, `bond_waivers_issued`
- Accept-402, bond-402, unpaid Echo 402, and settle_fee success bodies include `feedback_url`, `feedback_skill`, `feedback_hint`.

## OrphanDust micro-SKU (fixed unlock credits)
- **Catalog:** `GET https://dualregistry.dev/ORPHANDUST.json` (= `/PRODUCT.json`)
- **SKUs:** `od_unlock_050` $0.50/1cr · `od_credits_1` $1/1cr · `od_credits_2` $3/2cr · `od_credits_3` $5/3cr
- **Buy:** `POST /api/orphandust/buy` `{sku, agent_id?}` → **HTTP 402** invoice for SKU price; after `X-PAYMENT-*` → **RPC verify** then `{ok, credits, credit_token, balance_id, receipt}` (fail-closed)
- **Unlock:** `POST /api/orphandust/unlock` `{echo_id, credit_token}` **or** `GET /api/echo?echo_id=&credit_token=` — consumes **1 credit**, returns full legs (no % fee for that echo)
- **Ledger:** best-effort `/tmp` + HMAC `odc_…` credit_token (agent_fp, credits_remaining, exp, sku, sig)
- **quote_bond_usdc=0** — firm OBO quotes no longer require bond (ask_bps 10 / floor kept). Feedback waiver code retained (moot at bond=0).
- **% fee path unchanged:** agents can still pay `quoted_usdc` (~10 bps) via Echo GET / `settle_fee`.
- Stats: `orphandust_sku_sales`, `credits_issued`, `credits_redeemed`, `orphandust_revenue_usdc` (best-effort).
