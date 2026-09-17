# orphan-desk-source

**Production API source** for Orphan Desk / OrphanDust on dualregistry.dev.

- Vercel project: `orphan-desk-echo` (`prj_c4G2E8dK72jBKsovdx94mULlFxjM`)
- Deploy root: `public-feed/`
- NOT the JSON echo mirror at `manhatton31-svg/orphan-desk-echo`

## Grok Build #1 (approved)
Prune expired + same-asset from catalogs; match count_open; cheapest-live SPOTLIGHT; Echo 402 `cheaper_unlock` (od_unlock_050 $0.50); buy 402 `spend_on`. No SKU/bps/wallet/Stripe changes. Keep RPC verify_payment fail-closed.

## Deploy
From `public-feed/`: `vercel deploy --prod --scope` team owning the project.
