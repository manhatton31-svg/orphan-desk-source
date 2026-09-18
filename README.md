# orphan-desk-source

**Production API source** for Orphan Desk / OrphanDust on [dualregistry.dev](https://dualregistry.dev).

- Vercel project: `orphan-desk-echo` (`prj_c4G2E8dK72jBKsovdx94mULlFxjM`)
- Team: `team_YY4Cuwg6dmgWa9eNW0aFAvjV`
- Deploy root: `public-feed/`
- Git auto-deploy: this repo `main` → `orphan-desk-echo` (Root Directory `public-feed`)
- NOT the JSON echo mirror at `manhatton31-svg/orphan-desk-echo`

## Grok Build #1 (live)

Prune expired + same-asset from catalogs; match count_open; cheapest-live SPOTLIGHT; Echo 402 `cheaper_unlock` (od_unlock_050 $0.50); buy 402 `spend_on`. No SKU/bps/wallet/Stripe changes. Keep RPC verify_payment fail-closed.

## Deploy (production) — after every #1/#2/#3 patch

**Preferred:** `git push origin main` (auto-deploys `public-feed/` to dualregistry.dev).

Deploy root is `public-feed/` — NEVER deploy repo root, NEVER the JSON mirror repo.

Fallback CLI if auto-deploy is down:

```bash
cd public-feed
vercel link --yes --project orphan-desk-echo --team team_YY4Cuwg6dmgWa9eNW0aFAvjV
vercel deploy --prod --yes
```

Then curl-verify:

```bash
curl -sS https://dualregistry.dev/index.json | head
curl -sS -o /dev/null -w "%{http_code}" https://dualregistry.dev/.well-known/agent-card.json
# expect 200; report deploy URL / id
```

### Hard rules

- Do NOT create a new Vercel project
- Do NOT use deploy_to_vercel with a blank/scaffold tree (wipes prod)
- Do NOT deploy `manhatton31-svg/orphan-desk-echo` (JSON mirror)
- Keep middleware without `@vercel/edge`
- Keep `verify_payment` fail-closed
