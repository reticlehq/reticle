# Iris OEM / pipeline integration

> For platforms that generate or edit web apps (and any team running an agent over its own codebase):
> drive an Iris **verdict** from your own pipeline — no MCP, no human. You get back a stable
> `IrisVerificationRun`: did the generated app actually behave, what's risky, and how to fix it.

This is the contract and the recipe. The engine is built and tested; this page is how you wire it in.

---

## The loop

```text
prompt → generated diff → boot preview → POST /verify → verdict
          ↓ pass                                  ↓ fail / partial
        deploy + attach the run            feed repair packets to your agent → retry
```

One call replays your saved flows against the live preview, asserts program truth (network, state,
console, signals — not pixels), classifies the change set's risk, and returns a verdict you can gate on.

---

## 1. Embed the SDK (Apache-2.0)

The browser SDK is **Apache-2.0** — safe to ship inside the apps you generate for your customers. It is
**dev/preview-only** (tree-shaken from production), **localhost-only**, and sends **no telemetry**.

```bash
npm i -D @syrin/iris
```

Wire it into the preview build of your generated-app template (`npx iris init`, or the Vite/Next plugin).
See the per-package license model in the repo `LICENSE`.

## 2. Call the verify endpoint

Start the verify endpoint alongside your daemon (localhost-bound; the token is defence in depth):

```bash
iris serve --http --http-token "$IRIS_TOKEN"   # defaults to port 7331; --http-port N to change
```

Then POST your run metadata:

```bash
curl -s http://127.0.0.1:7331/verify \
  -H 'content-type: application/json' \
  -H "x-iris-token: $IRIS_TOKEN" \
  -d '{
        "project": { "name": "generated-app", "framework": "react", "previewUrl": "http://localhost:3000" },
        "trigger": { "kind": "oem", "diffRef": "<git-sha>" }
        // "names": ["signup","checkout"]   // omit to verify every saved flow
      }'
```

In-process (Node) you can skip HTTP and use `IrisRunner` directly — same artifact, byte-identical verdict.

A runnable ~20-line harness lives at [`docs/oem-verify-harness.mjs`](./oem-verify-harness.mjs).

## 3. Act on the verdict

The response is `{ run: IrisVerificationRun }`. The fields you'll use:

| Field                                      | Use it to                                          |
| ------------------------------------------ | -------------------------------------------------- |
| `verdict.status` (`pass`/`fail`/`partial`) | gate the deploy                                    |
| `verdict.blockingRisks`                    | block when a gated risk surface was touched        |
| `flows[]` (`status`, `failureReason`)      | show which journeys broke                          |
| `risks[]` (`surface`, `severity`, `gated`) | governance — auth/payment/db/destructive/…         |
| `repair.failurePackets[].suggestedPrompt`  | feed back to your coding agent to auto-fix         |
| `evidence`                                 | the console/network/state proof behind the verdict |

```js
const { run } = await res.json();
if (run.verdict.status !== 'pass') {
  for (const p of run.repair?.failurePackets ?? []) agent.send(p.suggestedPrompt); // self-heal
  process.exit(1); // don't deploy
}
```

---

## The artifact (`IrisVerificationRun`)

Stable, versioned (`schemaVersion: 1`), defined in `@syrin/iris-protocol` (`verification-run.ts`).
Additive-only within v1. Top-level: `runId`, `createdAt`, `durationMs`, `profile`, `project`, `agent`,
`trigger`, `changedFiles[]`, `flows[]`, `checks[]`, `risks[]`, `evidence`, `repair?`, `verdict`,
`signature?`.

### Profiles — what leaves your infra

- **`dev`** (default): full detail, including source `file:line` and app-state values. Stays local.
- **`prod-preview`**: for artifacts you surface downstream (attach to a deploy, show a customer). The
  `repair` block (which names source files) is **dropped** and app-state values are **redacted**, while
  the trustworthy summary (verdict, flows, risks, counts) is preserved. Set `"profile": "prod-preview"`.

Nothing is ever sent to Syrin — the artifact is written to `.iris/runs/<runId>.json` on your machine and
returned to your caller. Retrieve the latest (or by id) any time via the `iris_run_export` MCP tool.

---

## Risk governance

Pass your change set and a policy; touched surfaces become risk rows, and a gated surface fails the
verdict even when every flow passes:

```jsonc
{
  "changedFiles": [{ "path": "src/checkout/PayButton.tsx", "changeKind": "modified" }],
  "policy": { "requiresConfirmation": ["payment", "db", "destructive"] },
}
```

Surfaces: `auth`, `payment`, `db`, `migration`, `rls`, `secrets`, `destructive`, `external`. Apps can also
**declare** risk zones in their manifest (`governance.risk`) using the same vocabulary.

---

## Licensing for OEM

- **Embed freely**: the SDK packages are Apache-2.0 — ship them in your customers' apps.
- **The server/CLI** is FSL (free for your use; you just can't resell Iris itself as a competing service).
- **Enterprise features** (`ee/`) require a license key in production.

For an OEM/embedding agreement: **hey@syrin.ai**.

---

## FAQ

**Do we have to instrument the app?** For the deepest signal (state/source/signals), yes — but you own the
generated-app template, so it's a one-time addition to your scaffold. Flows replay deterministically after.

**Is this just a browser driver?** No. Iris reads _program truth_ from inside the app (network cardinality,
store/React state, emitted signals, console) — the bugs that look fine on a screenshot. See the benchmark.

**What does it cost in tokens?** Replays run with no LLM (~hundreds of tokens), versus re-driving a flow
with a model (~30k). The verdict is the cheap, deterministic part of your loop.
