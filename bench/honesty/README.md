# Honesty / false-green benchmark

Measures the dimension the fix-loop bench is blind to: **is a green verdict as honest as reality warrants?** v2.2.0 added the honesty block (coverage / integrity / grade); this proves it works and gates against regressions.

## Run

```bash
node bench/honesty/run-honesty.mjs   # deterministic, no agent/API cost; exit 1 on a false green or over-flag
```

Requires the server built (`pnpm --filter @reticlehq/server build`) — the runner imports the REAL honesty functions from `packages/server/dist`, so it scores the shipped composition, not a mock.

## Pieces

- `scenarios.mjs` — green acts over real wire-shaped windows, each with a `reality` ground truth (the caveat an honest verdict must disclose) + one caveat-free control.
- `run-honesty.mjs` — runs each through v2.2.0's real honesty block and a v2.1.0 model (no block → discloses nothing); scores false-green rate + over-flagging + a CI-gate demo.
- `results.md` — the scorecard and the honest reading of what it does/doesn't prove.

## Why this is the verification that matters

The fix-loop bench asks "does an agent fix bugs faster with Reticle" — capable agents don't need it, so it reads flat/negative and is confounded by a tiny fixture. v2.2.0 did not target that axis. It targeted **verifier honesty** — never let a green look stronger than the evidence. This bench measures exactly that.
