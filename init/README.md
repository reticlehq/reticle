# @reticlehq/init

The project scaffolder behind `reticle init`. Detects the framework and package manager, writes `.reticle.json`, patches the build config, generates the connect snippet and the agent rules, and registers the Reticle MCP server with whichever clients are on the machine.

Split out of [`@reticlehq/server`](https://www.npmjs.com/package/@reticlehq/server) because nothing in here observes a running app: it is a build-time codemod that runs once. Keeping it inside the daemon meant a typo in a generated snippet forced a republish of the MCP server, and every MCP user downloaded a scaffolder they run once or never.

You do not install this directly — `@reticlehq/server` depends on it and the `reticle` CLI drives it:

```bash
npx @reticlehq/server init
```

## Using it as a library

```ts
import { buildNodeIo, runInit, type InitHost } from '@reticlehq/init';

const io = buildNodeIo(process.cwd(), host); // host: version, tracing, telemetry, pairing token
const result = runInit(
  { cwd: process.cwd(), port: undefined, mcp: true, dryRun: false, install: true },
  io,
);
```

`InitHost` is the seam: everything the scaffolder cannot know for itself — the release version, a tracing hook, where to report the outcome, the bridge pairing token, the declared install channel — is supplied by the caller. That is what keeps this package free of any dependency on the daemon.

## License

FSL-1.1-ALv2 — free for any Permitted Purpose, converts to Apache-2.0 two years after release. See [LICENSE](./LICENSE).
