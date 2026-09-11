---
title: Specs for CI
description: 'Turn an interactive drive into a repeatable suite with @reticlehq/test: declarative specs bound to signals, never DOM structure.'
icon: vial
---

To run Reticle checks in CI, install `@reticlehq/test`, write specs with `reticleTest(name, async (t) => …)`, then boot a headless session with `bootSession({ driveUrl, headless: true })` and run them with `runSpecs`. Exit non-zero when `summary.failed` is not `0`. Specs bind to **signals and testids, never DOM structure**, so they survive the refactors that break selector-based suites.

Driving Reticle interactively is reconnaissance. This page is how you make it repeatable.

```ts
import { reticleTest } from '@reticlehq/test';

reticleTest('add a task', async (t) => {
  await t.act('add-task', 'click');
  await t.expectElement({ testid: 'task-list' }, 'visible');
});

reticleTest('ai chat edit', async (t) => {
  await t.fill('chat-input', 'Make the hook punchier');
  await t.act('chat-send', 'click');
  await t.expectNet('POST', '/chat-script', 200);
  await t.expectSignal('chat:edit-applied', { sections: ['hook'] });
});
```

## The test context `t`

A thin, typed façade over Reticle's tools. It resolves testids → refs for you, so specs never touch refs or DOM:

| Method | What it does |
| --- | --- |
| `t.act(testid, action, args?)` | perform an action on a testid'd element |
| `t.fill(testid, value)` | fill an input |
| `t.actAndWait(testid, action, until)` | act, then block until a predicate holds |
| `t.expectSignal(name, dataMatches?)` | assert an app signal fired (with optional data match) |
| `t.expectNet(method, urlContains, status?)` | assert a network call happened |
| `t.expectElement(query, state?)` / `t.expectText(contains)` / `t.expectAbsent(query)` | DOM assertions |
| `t.expectNoConsoleErrors()` | assert the flow produced no console errors |
| `t.state(storeOrRef)` | read a registered store / a component's state |
| `t.clock.freeze() / advance(ms) / reset()` | deterministic time (toasts, debounces, auto-dismiss) |
| `t.expectInputModeReal()` | guard: pass under real input, else **skip with a reason** |

Any failed matcher throws with the structured evidence (near-miss, failure reason) so the runner reports _why_.

## Deterministic + honest

- **`t.clock`** bakes `reticle_clock` into the spec, so time-gated UI (a 5s auto-dismiss, a 500ms hover dwell) is tested deterministically instead of racing real timers.
- **`t.expectInputModeReal()`**: a hover/drag spec asserts native input is active; if it's running synthetic (no CDP), the spec is **skipped with a reason**, never silently passing on a no-op. Enable real input headless with `reticle drive` (see [usage §18](usage.md#18-real-input-mode-native-hover--drag)).

## Run a suite (headless, the same path CI uses)

`bootSession` launches a headless real-input browser at your app and gives the runner a programmatic tool invoker (no MCP/stdio):

```ts
import { reticleTest, bootSession, runSpecs, createTestContext } from '@reticlehq/test';

// … reticleTest(...) registrations above …

const booted = await bootSession({ driveUrl: 'http://localhost:4310', headless: true });
const { summary } = await runSpecs({
  invoke: booted.invoke,
  now: () => Date.now(),
  buildContext: (invoke) => createTestContext(invoke, { sessionId: 'my-app' }),
  print: (line) => process.stdout.write(line + '\n'),
});
await booted.close();
process.exit(summary.failed === 0 ? 0 : 1);
```

Each spec reports `pass` | `fail` (with evidence) | `skip` (with reason). For CI, emit JUnit:

```ts
import { toJUnitXml, writeJUnit } from '@reticlehq/test';
```

## Flows become specs

`.reticle/` flows (see [Flows](flows.md)) can be executed directly as specs, replayed with their `expect`/`success` predicates and skipping `dynamic` (LLM-output) regions, so the recorded map and the suite can't drift apart:

```ts
import { flowsAsSpecs } from '@reticlehq/test';
// register one reticleTest per flow under .reticle/flows/
```

## Authoring tip: record → prune → commit

You don't have to hand-write steps. Drive the flow once (or record it via the panel), let Reticle emit the program, trim it, and commit it as a spec. The regression test is a byproduct of testing, not separate work.

## FAQ

### Do I need vitest or jest to run these?

No. `runSpecs` is its own runner: it takes the specs registered by `reticleTest`, an `invoke` function, and a `print` callback, and returns `{ results, summary }`. You can call it from a plain `node script.mjs`. If you already have vitest, nothing stops you calling `runSpecs` from inside a test, but the runner does not depend on one.

### How do I fail the CI job?

`runSpecs` never throws on a failing spec, so you have to read the summary and exit yourself:

```ts
process.exit(summary.failed === 0 ? 0 : 1);
```

`summary` carries `{ total, passed, failed, skipped, ok }`. Note that **skipped is not failed**: a spec that skipped with a reason (see `t.expectInputModeReal()`) leaves `failed` at `0`.

### Why did my hover or drag spec skip instead of running?

Because native input was not active. `t.expectInputModeReal()` deliberately skips with a reason rather than passing on a synthetic no-op, since a synthetic hover cannot trigger a CSS `:hover` or a pointer-library drag. If you want those specs to actually run, drive the app with real input: `npx @reticlehq/server drive http://localhost:4310`, or point the server at a CDP endpoint with `RETICLE_CDP_URL`.

### Does the app need to be running already?

Yes. The spec runner is attach-only and never starts your dev server (that is the interactive agent's job, not CI's). Boot your app first, then pass its URL as `driveUrl`. If nothing is listening there, `bootSession` opens a headless tab against a URL that serves nothing and no session ever connects.

### Can I emit JUnit for my CI's test reporter?

Yes, `toJUnitXml` and `writeJUnit` are both exported from `@reticlehq/test`. Pass them the results array from `runSpecs`.

### Do I have to write specs by hand if I already have flows?

No. `flowsAsSpecs` registers one `reticleTest` per flow under `.reticle/flows/`, replayed with that flow's own `expect` and `success` predicates and skipping its `dynamic` regions. That keeps the recorded map and the CI suite from drifting apart, because they are the same artifact.
