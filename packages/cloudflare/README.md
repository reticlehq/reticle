# @reticlehq/cloudflare

An optional, self-hosted implementation of Reticle's existing `verify: "server"` contract using Cloudflare Workers, Browser Rendering, Durable Objects, and R2.

It is intentionally private in the workspace: deploy it from a Reticle checkout with Wrangler rather than publishing it to npm.

```bash
pnpm --filter @reticlehq/cloudflare exec wrangler r2 bucket create reticle-cloudflare-artifacts
pnpm --filter @reticlehq/cloudflare exec wrangler secret put RETICLE_CLOUD_KEY
pnpm --filter @reticlehq/cloudflare deploy
```

See [the Cloudflare runner guide](../../docs/cloudflare-browser-run.mdx) for project linking, the deployed smoke test, security controls, and current evidence support.
