# Serving Intent Echoes with HTTP 402 (live)

Canonical host: `https://dualregistry.dev`

## Live behavior

1. **Catalog** — `GET /index.json` → 200 (free). Open book = ≥$2k notional + complete legs + future TTL.
2. **Stats / agent-card / PROMO / fill_hint** — free pheromone (fill_hint catalog sealed: `legs_locked`, no address/amount).
3. **Echo body** — `GET /{file}.echo.json` or `GET /api/echo?echo_id=…`:
   - Open + unpaid → **HTTP 402 Payment Required** with machine invoice (USDC Base preferred + USDT BSC).
   - `?preview=1` or `/preview/{id}` → free redacted preview.
   - Payment proof headers/query → auto `settle_fee` → 200 full echo + receipt.
   - Non-open statuses → 200 full body free.
4. Never attach email/Telegram/Discord contact flows to the 402 path.

## Invoice shape (402 body)

See `api/_lib/x402.js` `buildInvoice` — includes `amount`, `receive_wallet`, `echo_id`, preferred USDC/Base, accepted USDT/BSC, `pay_urls`, unlock instructions.

## Middleware

`public-feed/middleware.js` rewrites `*.echo.json` / `/preview/*` / `/redeem/*` to `/api/echo`.

6. **OBO accept → HTTP 402** — firm quote_fee with bid>=ask returns 402 invoice + quote_id; pay then GET with X-PAYMENT-* (+ X-QUOTE-ID). Exploratory is free indicative. Rate limit 10/10min. Middleware has no `@vercel/edge` dep.
