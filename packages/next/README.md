# @syrin/iris-next

Next.js helper for [Iris](https://github.com/syrin-labs/iris). Gives you **source-file mapping on Next.js without disabling SWC**.

React 19 removed `_debugSource`, and Next compiles with SWC (not Babel), so the `@syrin/iris-babel-plugin` route doesn't apply. `@syrin/iris-next` adds a **dev-only webpack pre-loader** that stamps `data-iris-source="file:line:col"` on your JSX _before_ SWC compiles it — so `iris_inspect` returns the component's source file, and SWC stays on (next/font, fast refresh, etc. all keep working).

```bash
npm i -D @syrin/iris-next
```

```js
// next.config.mjs
import irisNext from '@syrin/iris-next';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // ...your config
};

export default irisNext.withIris(nextConfig);
```

`withIris` is a **no-op in production** (`NODE_ENV=production`) — it only adds the loader in dev. Component identity (the component stack) works with or without it via [`@syrin/iris-react`](https://www.npmjs.com/package/@syrin/iris-react); this package adds the precise `file:line`. Apache-2.0.
