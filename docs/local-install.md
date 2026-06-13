# Use Iris in your own app — without publishing to npm

Iris isn't on public npm yet, and its packages depend on each other (`@iris/browser` →
`@iris/protocol`, etc.), so plain `npm pack` tarballs don't resolve cleanly. The reliable way
to test it in your **real external app today** is a tiny **local registry** (Verdaccio). This
is also exactly the path we use to validate publishing.

## 1. Publish @iris/\* to a local registry

From the Iris repo:

```bash
bash scripts/local-registry.sh
```

This starts Verdaccio on `http://localhost:4873`, creates a user/token, and publishes all
`@iris/*` packages there. (Verified: an external `npm i @iris/browser` then resolves the
whole graph, including `@iris/protocol`, and imports correctly.)

Leave it running.

## 2. Point your app at the local registry

In your app's project root, add an `.npmrc` (scopes only `@iris` to the local registry;
everything else still comes from npm):

```ini
@iris:registry=http://localhost:4873/
```

## 3. Install + wire it up

```bash
npm i -D @iris/browser @iris/react
# React 19 source mapping:
#   Vite/CRA  → npm i -D @iris/babel-plugin   (see docs/getting-started.md)
#   Next.js   → npm i -D @iris/next            (keeps SWC)
```

Then follow [Getting Started](getting-started.md): embed `iris.connect()` (dev only), add the
MCP server to your agent, and (React) `install()` the adapter.

**Run the MCP server** from the local registry too:

```jsonc
// .mcp.json — point npx at the local registry so it fetches @iris/server from Verdaccio
{
  "mcpServers": {
    "iris": {
      "command": "npx",
      "args": ["--registry", "http://localhost:4873/", "@iris/server"],
    },
  },
}
```

## Next.js specifics (verified on Next 15 / React 19)

`next.config.mjs`:

```js
import irisNext from '@iris/next';
/** @type {import('next').NextConfig} */
const nextConfig = {};
export default irisNext.withIris(nextConfig); // dev-only; keeps SWC; adds file:line mapping
```

Mount the SDK from a dev-only client component (see the Next.js section in
[Getting Started](getting-started.md)).

## When you're ready for real npm

The same packages publish to public npm unchanged — `pnpm -r publish --access public` after
`npm login`. The Verdaccio run above is a faithful rehearsal of that.

## Cleanup

```bash
pkill -f verdaccio     # stop the local registry
# remove the line from your app's .npmrc when you switch to published packages
```
