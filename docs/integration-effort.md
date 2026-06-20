# Integration effort — what it actually takes to adopt Iris

> Written from the seat of a head of engineering at Lovable / Emergent / Bolt evaluating Iris: is this
> in-app SDK integration, how much work is it really, and how do the paid (`ee`) features install +
> license on a user's machine? Grounded in the real API, with line counts.

## Yes — it's in-app SDK integration (and that's the point)

Iris isn't an external browser robot poking your app from outside; it reads the program from _inside_.
That requires the app to embed a **dev/preview-only** SDK (`@syrin/iris-browser`), tree-shaken from
production. For a platform, you add this **once to your generated-app template** — then every app you
generate is verifiable. The cost is per-platform, not per-app.

## Three layers of effort (adopt as much as you want)

### Layer 1 — DOM / network / console verification — EASY (~15 min, mostly automated)

What `npx iris init` wires for you:

- **1 line** in the build config (source mapping):
  `plugins: [babel({ plugins: [irisSource] }), react()]` (Vite) — or the Next plugin.
- **~10 lines** in a dev-only entry file that calls `iris.connect({ … })` once (see
  `apps/demo/src/iris-dev.ts`, `apps/next-smoke/app/iris-dev.tsx` for the exact, copyable pattern —
  including the dynamic-import guard that keeps it out of the prod bundle).
  This alone lets Iris drive the app and catch: network status/cardinality (double-submit, forbidden call),
  console errors, broken routes, persistence-after-reload. **Effort: trivial.**

### Layer 2 — program-state truth — EASY–MEDIUM (a few lines per store/signal)

The deep catches (UI-vs-store desync, dead handlers, blast-radius) need two tiny additions:

- **1 line per store:** `registerStore('app', () => useApp.getState())` — works with Zustand/Redux/any
  store exposing a snapshot.
- **1 line per consequence:** `iris.signal('order:saved', { id })` at the points that matter (or wrap it:
  `if (isDev) iris.signal(name, data)` — see `apps/demo/src/lib/iris-bridge.ts`).
- `data-testid` on key controls — most templates already have these.
  **Effort: a few dozen lines total in the template, written once.**

### Layer 3 — declared governance (optional) — MEDIUM

A domain manifest (`registerCapabilities`) declaring signals/stores/risk zones + a couple of recorded
flows with success oracles. Optional; raises the verdict's precision and unlocks risk policy. Skip for a
pilot.

## Setup-effort verdict

| Goal                                               | What you add                                              | Effort                                 |
| -------------------------------------------------- | --------------------------------------------------------- | -------------------------------------- |
| Drive + network/console/persistence checks         | 1 build line + ~10-line connect file (`npx iris init`)    | **Easy** (~15 min)                     |
| + program-state truth (the differentiated catches) | `registerStore` (1/store) + `iris.signal` (1/consequence) | **Easy–Medium** (≈ an afternoon, once) |
| + governance/risk policy                           | a manifest + a few recorded flows                         | **Medium**, optional                   |

For a generation platform the leverage is decisive: **instrument the scaffold once → every generated app
is covered.** Drive against the live preview with `iris serve --http --drive <previewUrl>`; the agent
never has to set anything up per build.

## How the paid (`ee`) features install + license — on the user's machine

There is **no separate install** and **no phone-home**:

1. **The pro code already ships** with the package, in `packages/server/src/ee/` — source-available under
   the Iris Enterprise License. It's free for development/testing/evaluation; it's just _there_.
2. **A license key unlocks production use.** Each `ee` feature calls `assertEnterprise(feature, ctx)`,
   which is a **no-op in dev/eval** and only enforces when the caller runs in production mode.
3. **The key is verified offline (Ed25519).** The user sets the issuer's public key once
   (`IRIS_LICENSE_PUBLIC_KEY` env) and provides their license key (env/config). `assertEnterprise` checks
   the signature, expiry, and that the key covers the feature — **entirely local, nothing leaves the
   machine** (preserves the no-telemetry brand).
4. **The issuer side is yours alone.** Syrin mints keys with `signLicenseKey(payload, privateKey)` using a
   private key that never ships. (Operate it as a small internal CLI/service; keep the private key secret.)

So the answer to "how do pro features install on the user's machine?": they don't need to — they're
already in the open, source-available package; a signed, offline license key flips them on in production.
This is the standard, trusted open-core pattern (PostHog/Cal.com-style), and it keeps the whole thing
inspectable.

## What would make a head of engineering hesitate (honest)

- **"We'll build it ourselves."** Real — some have. Counter: the depth (program-state + source mapping),
  determinism, the un-hallucinatable verdict, and a benchmark-driven year are expensive to reproduce.
- **"Instrumenting our template is work."** True but one-time and small (the line counts above); `iris init`
  automates Layer 1. Quantify it for them.
- **"It's React-first."** Deepest value (component→source, store) is React/Next today; network/console/
  persistence work anywhere. Be upfront about framework coverage.
- **"Is the SDK truly absent from prod?"** The brand promise. Worth shipping a CI guard that asserts it
  (recommended in `plan/SECURITY-REVIEW.md`).
- **Top improvements to raise the yes-rate:** an `iris init` template preset for generated-app scaffolds
  (one command instruments Layer 1+2), a Vue/Svelte adapter, and a one-command false-green demo.

## Bottom line

In-app SDK, yes — but a _small, one-time_ in-app integration (Layer 1 is ~15 min and automated; Layer 2 is
an afternoon, once, in the template). Pro features need no install — they ship in the open package and a
local, offline license key enables them in production. For a platform, the effort is low and the coverage
compounds across every app generated.
