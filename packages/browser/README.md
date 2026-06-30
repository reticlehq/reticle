# @reticle/browser

Browser SDK for [Reticle](https://github.com/reticlehq/reticle) — the proof layer for AI agents, embedded in your running web app. Embed it (dev only); it instruments the DOM, network, routes, console, animations, and scroll, and answers the agent's look/act/observe commands over a local bridge.

```bash
npm i -D @reticle/browser
```

```ts
import { reticle } from '@reticle/browser';
if (import.meta.env.DEV) reticle.connect({ session: 'my-app' });

// surface non-DOM events too:
reticle.signal('webhook:received', { provider: 'stripe' });
```

Pair with [`@reticle/server`](https://www.npmjs.com/package/@reticle/server) (the bridge + MCP server) and optionally [`@reticle/react`](https://www.npmjs.com/package/@reticle/react) for component/source mapping. See the [main README](https://github.com/reticlehq/reticle) for the full picture. Dev-only, localhost-only by default. MIT.
