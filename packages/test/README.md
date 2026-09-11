# @reticlehq/test

Reticle's spec runner for CI: write behavioral specs against your running app with `reticleTest`, drive them through Reticle's verification tools (DOM + network + console + app state) **without MCP/stdio**, and get a summary + JUnit XML your pipeline can gate on.

Part of [Reticle](https://github.com/reticlehq/reticle) — the in-app verification layer for AI agents. Use this package when you want the same inside-the-app assertions (signals, store state, network counts — the things a DOM-only tool can't see) as a plain CI test suite.

## Install

```bash
npm i -D @reticlehq/test
```

`vitest` is a peer dependency for the matcher integration; the standalone runner below needs only Node.

## Write a spec

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

The context `t` is a thin, typed façade over Reticle's tools — it resolves `data-testid`s to live elements for you, so specs never touch refs, selectors, or the DOM directly, and assertions run against the app's real network buffer, console, signals, and registered stores.

## Run in CI

```ts
import { bootSession, runSpecs, createTestContext, writeJUnit } from '@reticlehq/test';

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

`bootSession` launches a headless browser against your dev server via the Reticle daemon; `runSpecs` executes every registered spec and returns a machine-readable summary. `writeJUnit(...)` emits JUnit XML for CI dashboards.

## Main exports

| Export | Purpose |
| --- | --- |
| `reticleTest`, `register`, `getRegistered`, `clearRegistry` | spec registration |
| `runSpecs`, `runOne`, `summarize`, `printSummary` | execution + reporting |
| `toJUnitXml`, `writeJUnit` | CI artifact output |
| `bootSession` | boot a driven browser session without MCP |
| `createTestContext` | the `t` façade (act / expectElement / expectNet / expectSignal / expectState …) |
| `ReticleSkip`, `ReticleAssertionError`, `isSkip` | control-flow + failure types |

## Docs

- [Testing guide](https://github.com/reticlehq/reticle/blob/main/docs/testing.md)
- [Getting started with Reticle](https://github.com/reticlehq/reticle/blob/main/docs/getting-started.md)

## License

FSL-1.1-ALv2 — free for any use except reselling Reticle itself; converts to Apache-2.0 after two years. See [LICENSE](./LICENSE).
