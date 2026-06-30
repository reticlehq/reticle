# @reticle/next

Next.js helper for [Reticle](https://github.com/reticlehq/reticle). Gives you **source-file mapping on Next.js without disabling SWC**.

React 19 removed `_debugSource`, and Next compiles with SWC (not Babel), so the `@reticle/babel-plugin` route doesn't apply. `@reticle/next` adds a **dev-only webpack pre-loader** that stamps `data-reticle-source="file:line:col"` on your JSX _before_ SWC compiles it — so `reticle_inspect` returns the component's source file, and SWC stays on (next/font, fast refresh, etc. all keep working).

```bash
npm i -D @reticle/next
```

```js
// next.config.mjs
import reticleNext from '@reticle/next';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // ...your config
};

export default reticleNext.withReticle(nextConfig);
```

`withReticle` is a **no-op in production** (`NODE_ENV=production`) — it only adds the loader in dev. Component identity (the component stack) works with or without it via [`@reticle/react`](https://www.npmjs.com/package/@reticle/react); this package adds the precise `file:line`. Apache-2.0.
