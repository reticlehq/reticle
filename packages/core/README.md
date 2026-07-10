# @reticlehq/core

The **foundation** of [Reticle](https://github.com/reticlehq/reticle) — the shared wire contract that every Reticle package imports: types, [zod](https://zod.dev) schemas, constants, and the messages that cross the browser ↔ bridge ↔ agent boundary. It is isomorphic (runs in a browser or in Node), depends only on `zod`, and re-exports nothing.

Most people never install this directly. Install the package for your audience instead:

- **Browser app:** `npx @reticlehq/server init` (wires `@reticlehq/react` + a build plugin)
- **Agent / MCP:** `npx @reticlehq/server mcp`
- **CI specs:** `@reticlehq/test`

See the [main README](https://github.com/reticlehq/reticle) and [MIGRATION.md](https://github.com/reticlehq/reticle/blob/main/MIGRATION.md).

## The wire contract as JSON Schema

`@reticlehq/core` ships machine-readable [JSON Schema](https://json-schema.org) for the wire contract under `dist/schema/`, generated from the zod schemas so the two can never drift (a parity test enforces it). This is the **conformance target for non-TypeScript SDKs**: a Python, Go, or Rust SDK validates its messages against these schemas without importing the TypeScript library.

```js
import reticleMessage from '@reticlehq/core/schema/reticle-message.json' with { type: 'json' };
```

Shipped schemas: `reticle-message`, `reticle-event`, `hello-message`, `command-message`, `command-result`, `event-message`, `event-type`.

## License

Apache-2.0.
