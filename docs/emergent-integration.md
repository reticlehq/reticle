# Integrating Iris into an Emergent-style ecosystem

> Concretely, how Iris would slot into an AI app-builder platform that generates full-stack apps in
> isolated sandboxes (Emergent's documented architecture: a Kubernetes pod per build with a
> reverse-proxied preview URL, an orchestrator spawning subagents, a generate→test→iterate loop). This
> is the _technical_ integration; for the competitive read and the "build vs buy" honesty see
> `bench/EMERGENT-COMPARISON.md`.

## Where Iris fits

A platform's loop today is roughly: **plan → provision sandbox → write code → (its own tests) →
iterate → publish.** Iris becomes the **verification worker** in that loop — the step that produces a
trustworthy, evidence-backed verdict before "publish", and feeds precise fixes back when it fails.

```
prompt → generate/edit → boot preview in pod ──► Iris verify ──► verdict + evidence + repair
                                                     │                    │
                                          (runs against the live          ├─ PASS → publish + attach "verified ✓"
                                           preview in the same pod)        └─ FAIL → route repair packets to the
                                                                              fixer subagent → re-verify (self-heal)
```

## The integration points (3 of them)

1. **Embed the SDK in the generated-app template (once).** Add `@syrin/iris-browser` to the scaffold's
   preview build (Apache-2.0 — safe to ship in customer apps; dev/preview-only, tree-shaken from prod).
   Expose the store + emit a few domain signals. Every app the platform generates is now verifiable.
2. **Run the verify endpoint in the pod, next to the preview.** Each build already gets an isolated pod
   with a preview URL — start Iris there:
   ```bash
   iris serve --http --http-token "$POD_TOKEN" --drive "$PREVIEW_URL"
   ```
   or call `IrisRunner` in-process (Node) — same artifact, byte-identical verdict.
3. **Call verify from the orchestrator and act on the result.**

   ```js
   const { run } = await (
     await fetch('http://127.0.0.1:7331/verify', {
       method: 'POST',
       headers: { 'content-type': 'application/json', 'x-iris-token': POD_TOKEN },
       body: JSON.stringify({
         project: { name, framework, previewUrl },
         trigger: { kind: 'oem', diffRef },
       }),
     })
   ).json();

   if (run.verdict.status !== 'pass') {
     for (const p of run.repair?.failurePackets ?? []) fixerSubagent.send(p.suggestedPrompt); // self-heal
     return blockPublish(run); // don't ship broken
   }
   attachToBuild(run); // the user-facing "verified ✓" evidence; set profile:"prod-preview" to redact internals
   ```

## Step by step (one build)

1. Orchestrator provisions the pod; the generated app (with the embedded SDK) serves at the preview URL.
2. `iris serve --http --drive $PREVIEW_URL` comes up in the pod (or `IrisRunner` is imported).
3. Orchestrator `POST /verify` with the project + diff metadata.
4. Iris replays the critical flows against the live preview, asserts program-truth consequences
   (network/state/console/signals), classifies risk, returns an `IrisVerificationRun`.
5. **FAIL/PARTIAL:** the orchestrator feeds `repair.failurePackets[].suggestedPrompt` to the fixer
   subagent, which patches and re-verifies — the loop closes without a human, with evidence each round.
6. **PASS:** publish, and attach the (redacted, `prod-preview`) run as the trust signal the end user sees.
7. The artifact persists (`.iris/runs/`) for audit / regression diffing across edits.

## What this buys the platform (vs its own QA)

- **A verdict that can't be hallucinated.** Iris reads real network/state/console, so it can't report
  "97% effective" with nothing running (the documented failure mode of narrated, LLM-driven QA). No
  evidence → fail, never a confident green. (`false-green.test.ts`)
- **Deterministic + cheap on every edit.** Replays run with no LLM (~175 tok/run, 0% flake), so the same
  edit re-verifies identically — 128–2574× cheaper than re-driving with a model, and CI-gateable.
- **Program-truth catches** the platform's vision/DOM QA is blind to: mock-data persistence, dead
  handlers, double-submit, blast-radius — the exact "looks done but isn't" churn drivers.
- **A repair packet, not just a red X** — what broke and where, ready for the fixer subagent.

## Honest caveats

- **Build-vs-buy is real.** A platform _can_ build a verification step (some have). The argument for Iris
  is the depth (program-state + source mapping), the determinism, the un-hallucinatable verdict, and the
  stable artifact — a benchmark-driven year that's expensive to reproduce, available as a drop-in.
- **Captive harnesses can't be A/B'd automatically.** To compare on equal footing, use the
  pre-registered manual protocol in `bench/AB-EXPERIMENT.md` (and the false-green test first).
- **Deepest checks need the one-time template instrumentation.** Network/console/persistence work via the
  driven browser alone; state/signals/source need the embedded SDK. It's a scaffold change, done once.

OEM / embedding terms: **hey@syrin.ai**.
