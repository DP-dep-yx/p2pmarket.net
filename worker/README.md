# p2pmarket.net — Cloudflare Worker

Static site + SIWE (EIP-4361) auth backend, deployable on the **Cloudflare free plan**.

## What it serves

- All static files from the repo root (`worker/public`, synced by `npm run sync`) via **Workers Assets** (free, unlimited requests).
- API endpoints handled by `worker.js` (free plan: 100,000 requests/day):
  - `GET /api/auth/nonce` — issues a single-use nonce (10 min TTL).
  - `POST /api/auth/verify` — parses the EIP-4361 message, checks domain/chain (Base 8453 or 84532), consumes the nonce, recovers the signer address via secp256k1 + keccak, and sets a signed HMAC session cookie.
  - `GET /api/auth/session` — returns the current session.

Nonce storage is in-isolate memory (best-effort single-use). For strict guarantees add a KV namespace binding and swap the `nonces` Map for KV reads/writes.

## Deploy

Requires an API token with **Account → Workers Scripts: Edit** (the DNS-scoped token is not enough).

```bash
cd worker
npm install
npx wrangler secret put WORKER_SECRET   # random string, once
npm run deploy                          # sync assets + wrangler deploy
```

Preview without an account:

```bash
npm run sync
npm run dev            # wrangler dev on 127.0.0.1:8787, local mode
node scripts/siwe-test.mjs   # end-to-end SIWE verify + replay test
```

## Attach the custom domain

Needs **Workers Custom Domains: Edit** (or zone-level **Workers Routes: Edit**):

```bash
npx wrangler domains attach p2pmarket.net        # Wrangler v4
# or REST: PUT /accounts/{account_id}/workers/domains
#   { "zone_id": "5938aa629d99da090b05203124f4646d", "hostname": "p2pmarket.net",
#     "service": "trustmarkets", "environment": "production" }
```

Cloudflare will replace the DNS records for `p2pmarket.net` with a proxied record pointing at the Worker (remove the four GitHub Pages `A` records first if they conflict). The `www` CNAME can stay pointed at `dp-dep-yx.github.io` or be added as a second custom domain.

## Rollback to GitHub Pages

Delete the Workers route/custom domain and restore the four `A` records (`185.199.108–111.153`, unproxied). The repo keeps serving the same static files via Pages in the meantime.
