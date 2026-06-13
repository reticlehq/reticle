# Iris benchmark graphics

15 trust/authority stat cards for the Iris open-source project, on the v2 design system
(`assets/marketing/src/_system.css` — Inter, mesh + grain, mono-for-code only). Every number is
**verified** against `docs/token-efficiency.md`, the repo, or the live demo runs — no fabricated
stars/users. Regenerate with `node assets/benchmarks/render.mjs` (edits live in `src/*.html`).

| # | File | Size | What it shows | Best for |
| - | ---- | ---- | ------------- | -------- |
| 01 | `01-token-bar-dark` | 1600×1000 | ~100 vs ~7,300 tokens/step, 73× bar chart | README hero, X |
| 02 | `02-token-breakdown-light` | 1600×1000 | Per-op cost (query 28 … full 4,144) | docs, light decks |
| 03 | `03-flow-cost-square` | 1080×1080 | 20-step flow: ~2k vs ~146k | Instagram/LinkedIn |
| 04 | `04-honest-benchmark` | 1600×1000 | 73× loop vs 1.8× full-tree (trust via honesty) | HN, skeptics |
| 05 | `05-capability-matrix` | 1600×1000 | Iris vs Playwright MCP / Chrome DevTools MCP / screenshot | comparison, sales |
| 06 | `06-screenshots-cant-see` | 1600×1000 | What a screenshot misses vs what Iris sees | the core pitch |
| 07 | `07-og-social` | 1200×630 | Social/OG share card | og:image, link previews |
| 08 | `08-footprint-grid` | 1600×1000 | 44 tools · 7 observers · 95 test files · MIT | "under the hood" |
| 09 | `09-determinism-terminal` | 1600×1000 | The assert JSON verdict, ~10ms, no vision | developers |
| 10 | `10-red-green-flow` | 1600×1000 | 401 → one-line fix → 200 | the demo story |
| 11 | `11-economics-linechart` | 1600×1000 | Cumulative tokens diverge over 20 steps | "run on every edit" |
| 12 | `12-coverage-donut` | 1080×1080 | The 6 reaction types it verifies | feature overview |
| 13 | `13-speed-stats` | 1600×1000 | ~10ms verdict · ~0.9s/interaction · 60s tour | speed claims |
| 14 | `14-trust-strip` | 1600×480 | MIT · dev-only · localhost-only · no telemetry | README badge strip |
| 15 | `15-screenshot-cost` | 1200×630 | ~1,500 token screenshot vs ~33 token assert | social, the cost angle |

**Sources for the numbers:** token figures — `docs/token-efficiency.md` (reproducible via
`plan/vs-playwright.mjs`); footprint — repo counts (~44 MCP tools, 7 observers, 95 test files,
~12.5k test lines, v0.3.10); speed — live demo session (60.6s tour, ~0.9s/interaction);
screenshot/competitor token costs — published research cited in `plan/market/02-competitive-landscape.md`.
