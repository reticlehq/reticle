# @syrin/iris-browser

Browser SDK for [Iris](https://github.com/syrin-labs/iris) — gives AI coding agents eyes into your running web app. Embed it (dev only); it instruments the DOM, network, routes, console, animations, and scroll, and answers the agent's look/act/observe commands over a local bridge.

```bash
npm i -D @syrin/iris-browser
```

```ts
import { iris } from '@syrin/iris-browser';
if (import.meta.env.DEV) iris.connect({ session: 'my-app' });

// surface non-DOM events too:
iris.signal('webhook:received', { provider: 'stripe' });
```

Pair with [`@syrin/iris-server`](https://www.npmjs.com/package/@syrin/iris-server) (the bridge + MCP server) and optionally [`@syrin/iris-react`](https://www.npmjs.com/package/@syrin/iris-react) for component/source mapping. See the [main README](https://github.com/syrin-labs/iris) for the full picture. Dev-only, localhost-only by default. MIT.
