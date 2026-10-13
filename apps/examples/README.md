# examples — framework integration examples

**Job: integration proof, for frameworks with no smoke app of their own.** Each is a minimal app that wires the SDK the way a user of that framework does.

| Example | Why it exists |
| --- | --- |
| `react/` | Vite + React with the `reticle()` plugin. |
| `next/` | Next.js App Router with `withReticle` and a client connect. |
| `remix/` | The only Remix coverage. `SKILL.md` offers Remix to users. |
| `astro/` | Astro renders its own HTML on the server, so the Vite plugin's `index.html` connect injection never runs. It connects from a bundled client script instead. |

**Gate:** `pnpm test:integration` (`test/frameworks.integration.test.ts`) boots each example and checks that it connects. CI runs it in the e2e job.
