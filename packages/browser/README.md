# @iris/browser

Browser SDK for [Iris](https://github.com/iris-mcp/iris) — gives AI coding agents eyes into
your running web app. Embed it (dev only); it instruments the DOM, network, routes, console,
animations, and scroll, and answers the agent's look/act/observe commands over a local bridge.

```bash
npm i -D @iris/browser
```

```ts
import { iris } from '@iris/browser';
if (import.meta.env.DEV) iris.connect({ session: 'my-app' });

// surface non-DOM events too:
iris.signal('webhook:received', { provider: 'stripe' });
```

Pair with [`@iris/server`](https://www.npmjs.com/package/@iris/server) (the bridge + MCP
server) and optionally [`@iris/react`](https://www.npmjs.com/package/@iris/react) for
component/source mapping. See the [main README](https://github.com/iris-mcp/iris) for the
full picture. Dev-only, localhost-only by default. MIT.
