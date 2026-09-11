# examples — framework integration examples

**Job: integration proof, for frameworks with no smoke app of their own.** Each is a minimal app wiring the SDK the way a user of that framework would.

| Example | Why it exists | Gate |
| --- | --- | --- |
| `astro/` | Astro SSRs its own HTML, so the Vite plugin's `index.html` connect-injection never fires — it connects from a bundled client script instead. That difference is worth keeping honest. | ❌ none |
| `remix/` | Only Remix coverage. `SKILL.md` offers Remix to users. | ❌ none |

**Both are currently ungated** — tracked in `packages/server/src/tools/integration-coverage.test.ts`, which pins the gap so it stays visible. An example that nothing runs is a promise nobody checks.

`examples/next` and `examples/react` were deleted: they duplicated wiring `next-smoke` and `bench-app` already prove, no doc linked to them, and no gate ran them.
