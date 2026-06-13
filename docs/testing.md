# Testing with `@syrin/iris-test` — declarative, signal-bound specs

Driving Iris interactively is reconnaissance. To turn it into a **repeatable, CI-runnable**
suite, write declarative specs with `@syrin/iris-test` (bundled in `@syrin/iris`, importable at
`@syrin/iris/test`). Specs bind to **signals and testids — never DOM structure** — so they
inherit Iris's refactor-resistance.

```ts
import { irisTest } from '@syrin/iris/test';

irisTest('add a task', async (t) => {
  await t.act('add-task', 'click');
  await t.expectElement({ testid: 'task-list' }, 'visible');
});

irisTest('ai chat edit', async (t) => {
  await t.fill('chat-input', 'Make the hook punchier');
  await t.act('chat-send', 'click');
  await t.expectNet('POST', '/chat-script', 200);
  await t.expectSignal('chat:edit-applied', { sections: ['hook'] });
});
```

## The test context `t`

A thin, typed façade over Iris's tools — it resolves testids → refs for you, so specs never
touch refs or DOM:

| Method                                                                                | What it does                                              |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `t.act(testid, action, args?)`                                                        | perform an action on a testid'd element                   |
| `t.fill(testid, value)`                                                               | fill an input                                             |
| `t.actAndWait(testid, action, until)`                                                 | act, then block until a predicate holds                   |
| `t.expectSignal(name, dataMatches?)`                                                  | assert an app signal fired (with optional data match)     |
| `t.expectNet(method, urlContains, status?)`                                           | assert a network call happened                            |
| `t.expectElement(query, state?)` / `t.expectText(contains)` / `t.expectAbsent(query)` | DOM assertions                                            |
| `t.expectNoConsoleErrors()`                                                           | assert the flow produced no console errors                |
| `t.state(storeOrRef)`                                                                 | read a registered store / a component's state             |
| `t.clock.freeze() / advance(ms) / reset()`                                            | deterministic time (toasts, debounces, auto-dismiss)      |
| `t.expectInputModeReal()`                                                             | guard: pass under real input, else **skip with a reason** |

Any failed matcher throws with the structured evidence (near-miss, failure reason) so the
runner reports _why_.

## Deterministic + honest

- **`t.clock`** bakes `iris_clock` into the spec, so time-gated UI (a 5s auto-dismiss, a 500ms
  hover dwell) is tested deterministically instead of racing real timers.
- **`t.expectInputModeReal()`** — a hover/drag spec asserts native input is active; if it's
  running synthetic (no CDP), the spec is **skipped with a reason**, never silently passing on a
  no-op. Enable real input headless with `iris drive` (see [usage §18](usage.md#18-real-input-mode--native-hover--drag-m58)).

## Run a suite (headless, the same path CI uses)

`bootSession` launches a headless real-input browser at your app and gives the runner a
programmatic tool invoker (no MCP/stdio):

```ts
import { irisTest, bootSession, runSpecs, createTestContext } from '@syrin/iris/test';

// … irisTest(...) registrations above …

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
import { toJUnitXml, writeJUnit } from '@syrin/iris/test';
```

## Flows become specs

`.iris/` flows (see [Flows](flows.md)) can be executed directly as specs — replayed with their
`expect`/`success` predicates and skipping `dynamic` (LLM-output) regions — so the recorded map
and the suite can't drift apart:

```ts
import { flowsAsSpecs } from '@syrin/iris/test';
// register one irisTest per flow under .iris/flows/
```

## Authoring tip: record → prune → commit

You don't have to hand-write steps. Drive the flow once (or record it via the panel), let Iris
emit the program, trim it, and commit it as a spec — the regression test is a byproduct of
testing, not separate work.
