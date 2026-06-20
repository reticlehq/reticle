# Integrate Iris in 10 minutes

> Two paths. Pick the one that matches you. Both end with an agent (or your pipeline) getting a
> **verdict with evidence** — "did the app actually do the thing?" — instead of a hopeful "done."

---

## Path A — a team using a coding agent on your own app (~10 min)

For React/Next/Vite apps where Claude Code / Cursor / any MCP agent edits your code.

### 1. Install (1 min)

```bash
npm i -D @syrin/iris        # or pnpm add -D / yarn add -D
```

### 2. Let the agent wire itself up (2 min)

Paste this to your agent:

```text
Follow https://raw.githubusercontent.com/syrin-labs/iris/main/SKILL.md
```

It runs the setup wizard the first time (adds the Vite/Next plugin + SDK init, registers the MCP
server), then verifies your app on every change after. Prefer to do it yourself? `npx iris init` does
the same non-interactively.

### 3. Run your app as usual (1 min)

```bash
npm run dev
```

Open it once; the dev-only SDK connects to the local bridge. (It's tree-shaken from production and binds
to localhost — nothing leaves your machine.)

### 4. Ask the agent to verify (5 min)

Tell your agent to build or fix something, then: _"verify it with Iris."_ It will:

- `iris_query` / `iris_snapshot` — see the app,
- `iris_act_and_wait` — click/type and wait for it to settle,
- `iris_assert` — check the **consequence** (the POST returned 200, the modal opened, the store updated,
  no console error),
- and on a real flow, record it so it can `iris_flow_replay` deterministically next time (~175 tokens,
  0% flake) as a regression gate.

That's it. The agent now checks its own work before telling you it's done.

---

## Path B — an OEM platform embedding Iris in your generation pipeline (~10 min)

For platforms that generate/edit apps for users and want a programmatic verdict — no MCP, no human.

### 1. Embed the SDK in your generated-app template (3 min)

```bash
npm i -D @syrin/iris        # Apache-2.0 — safe to ship inside the apps you generate
```

Add the Vite/Next plugin (or `npx iris init`) to the preview build of your scaffold. Done once, it
applies to every app you generate.

### 2. Start the verify endpoint next to your preview (1 min)

```bash
iris serve --http --http-token "$IRIS_TOKEN"     # localhost:7331; add --drive <preview-url> for a headless preview
```

### 3. Call it from your pipeline (5 min)

```js
const res = await fetch('http://127.0.0.1:7331/verify', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-iris-token': process.env.IRIS_TOKEN },
  body: JSON.stringify({
    project: { name: 'generated-app', framework: 'react', previewUrl },
    trigger: { kind: 'oem', diffRef: gitSha },
    // names: ['signup','checkout'],   // omit to verify every saved flow
  }),
});
const { run } = await res.json();
```

### 4. Act on the verdict (1 min)

```js
if (run.verdict.status !== 'pass') {
  for (const p of run.repair?.failurePackets ?? []) agent.send(p.suggestedPrompt); // self-heal
  blockDeploy(run.verdict.reasons); // don't ship broken
} else {
  attachToDeploy(run); // "verified ✓" evidence
}
```

The `run` is a stable `IrisVerificationRun`: `verdict`, per-flow results, `risks` (auth/payment/db/…),
`repair.failurePackets`, and `evidence`. Set `"profile":"prod-preview"` to redact internals before
showing it downstream. Full field guide + the runnable harness: [`oem-integration.md`](./oem-integration.md).

---

## Why it's this fast

- **One SDK, one install, zero-config adapters** (Vite/Next auto-wire).
- **One stable artifact** (`IrisVerificationRun`) — not a bespoke API per check.
- **Plain HTTP _or_ MCP** — your choice; no LLM, no screenshots in the loop.
- **Apache-2.0 SDK** — legal clears embedding in minutes; **localhost + no telemetry** — security does too.

Need help: **hey@syrin.ai**.
