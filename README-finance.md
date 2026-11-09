# New Home Financial System

The public website remains at `/`. The protected application is at `/staff/`; its API is served by the Worker at `/api/`.

## Provisioning

1. Install Node 20+ and authenticate: `npx wrangler login`.
2. Create resources: `npx wrangler d1 create new-home-finance` and `npx wrangler r2 bucket create new-home-receipts`.
3. Put the returned D1 ID in `wrangler.toml`, copy `.dev.vars.example` to `.dev.vars`, and set strong unique secrets.
4. Apply schema: `npm install`, then `npm run db:migrate`.
5. Deploy the Worker and serve the static files (including `staff/`) through Cloudflare Pages with `/api/*` routed to this Worker, or deploy the Worker as the same-origin application gateway.

The first login bootstraps the admin from the two `BOOTSTRAP_ADMIN_*` secrets, then remove those two secrets. Do not commit `.dev.vars`, real IDs, or secrets.

## Recovery

Use scheduled D1 exports/backups and R2 object versioning/retention. Financial records are never deleted: voids, rejections, and cancellations preserve the original record and audit history.
