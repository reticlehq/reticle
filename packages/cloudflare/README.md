# @reticlehq/cloudflare

An optional, self-hosted implementation of Reticle's existing `verify: "server"` contract using Cloudflare Workers, Browser Rendering, Durable Objects, and R2.

The automatic path provisions Cloudflare, deploys and secures the Worker, links the current repository, enables server verification, uploads existing flows and runs, and finishes with a real Browser Run smoke check:

```bash
npx @reticlehq/cloudflare init
```

Preview every mutation before it happens with `npx @reticlehq/cloudflare init --dry-run`. The remote runner uses four isolated contexts by default; choose another bound with `--parallel 1..10`.

See [the Cloudflare runner guide](../../docs/cloudflare-browser-run.mdx) for project linking, the deployed smoke test, security controls, and current evidence support.
