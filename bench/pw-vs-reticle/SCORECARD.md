# Playwright-script vs Reticle-script — thin slice

App under test: `apps/bench-app` (http://localhost:4312). Deterministic scripts, no LLM.

| Bug | Category | Expected catcher | Reticle-script | Playwright-script |
|---|---|---|:--:|:--:|
| invisible | ui-visual | both | ✅ | ✅ |
| occluded | ui-visual | both | ✅ | ✅ |
| paint-filter | ui-paint | playwright-only | ⬜ | ✅ |
| state-desync | state | reticle-only | ✅ | ⬜ |
| console-leak | console | both | ✅ | ✅ |
| double-submit | network | both | ✅ | ✅ |
| mutation-leak | state-blast-radius | reticle-only | ✅ | ⬜ |

## Summary

| Metric | Reticle-script | Playwright-script |
|---|--:|--:|
| Bugs caught | 6/7 | 5/7 |
| Caught of those it *can* catch | 6/6 | 5/5 |
| False positives (clean build) | 0 | 0 |
| Avg output consumed / bug | 5701 B | 57479 B |
| Avg wall-time / bug | 2911 ms | 31798 ms |

> "Expected catcher" is the ground-truth capability line: `both`, `reticle-only` (needs app state / commit stream), or `playwright-only` (needs pixels).
