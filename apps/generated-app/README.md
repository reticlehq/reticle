# Generated-app reference (verify-me-with-Iris)

A self-contained, full-stack **Expense Tracker** that mimics what an AI app-builder emits — a frontend + a JSON API + a data store, served from one Node process, no build, no deps. Its job is to be **deliberately broken on demand** so you can watch Iris catch the silent failures vibe-coded apps ship with.

## Run it

```bash
node apps/generated-app/server.mjs            # everything works (BUG_MODE=none)
BUG_MODE=mock-data   node apps/generated-app/server.mjs   # POST "succeeds" but nothing persists
BUG_MODE=dead-delete node apps/generated-app/server.mjs   # DELETE returns 200 but never removes
BUG_MODE=double-submit node apps/generated-app/server.mjs # the Add button fires POST twice
BUG_MODE=no-validation node apps/generated-app/server.mjs # "abc" is accepted as an amount
BUG_MODE=wrong-total node apps/generated-app/server.mjs   # the Total lies (UI ≠ data)
BUG_MODE=console-error node apps/generated-app/server.mjs # an action logs console.error, UI renders
```

Then open `http://localhost:4500`. Each `BUG_MODE` is exactly one silent-failure class — the kind that **looks done but isn't**, so a screenshot/"does it look right" check sails right past it.

## What each bug is, and how Iris catches it

| `BUG_MODE` | The silent failure | How Iris catches it (the verdict) |
| --- | --- | --- |
| `mock-data` | POST returns 200, UI shows the row, but it's never stored | `state`/persistence oracle: the list doesn't survive reload; store length didn't change |
| `dead-delete` | Delete looks done; the item is back on refresh | `state` desync: server truth ≠ UI; reload shows it |
| `double-submit` | One click, two `POST`s, two rows | `net { count: 1 }` cardinality check fails |
| `no-validation` | `"abc"` becomes an expense (NaN) | flow oracle: an error should appear AND no expense should be created — neither holds |
| `wrong-total` | The Total reads one more than the data | UI-vs-store desync: displayed total ≠ `store.total` |
| `console-error` | An error is logged; the UI still renders fine | `console { absent: true }` check fails |

Every one of these is **proven against Iris's real verdict logic** in `packages/server/src/runs/generated-app-bugs.test.ts` (runs in CI, no browser). This app is the live, clickable counterpart.

## Verify it with Iris (live)

The app already serves a small `window.__app` store (`expenses`, `total`) — the seam an instrumented build exposes for state-truth checks.

```bash
# 1. start the buggy app
BUG_MODE=mock-data node apps/generated-app/server.mjs

# 2. point Iris at it (drives a headless browser to the preview) + open the verify endpoint
iris serve --http --http-token dev --drive http://localhost:4500

# 3. from your pipeline / harness, ask for a verdict
curl -s localhost:7331/verify -H 'x-iris-token: dev' -H 'content-type: application/json' \
  -d '{"project":{"name":"expense-tracker","framework":"other","previewUrl":"http://localhost:4500"}}'
# → an IrisVerificationRun: the add-expense flow fails its persistence oracle; verdict = fail, with the fix.
```

> Coverage note (honest): network, console, double-submit, and persistence-after-reload are catchable on this no-build app via the driven browser. The deepest **program-state** checks (blast-radius, store invariants) light up fully once the app embeds `@syrin/iris-browser` and registers its store/signals — a one-time addition to a generated-app template. See `docs/integration.md`.

## The point

This is the silent-failure problem made concrete: a builder that ships any of these modes "looks done" to a screenshot and to the user — until the Pay/Save/Delete doesn't do what it claimed. Iris turns each into a deterministic, evidence-backed **fail** with a fix, instead of a confident green.
