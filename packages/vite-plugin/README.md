# @syrin/iris-vite-plugin

One-line Vite integration for [Iris](https://github.com/syrin-labs/iris). The plugin does the whole
dev-time wiring for you:

- **Source mapping** — stamps `data-iris-source="file:line:col"` on JSX host elements (via
  [`@syrin/iris-babel-plugin`](https://www.npmjs.com/package/@syrin/iris-babel-plugin)) so
  `iris_inspect` can report the component's source file — needed on React 19.
- **Auto-connect** — injects a dev-only `install(); iris.connect()` so you don't touch your entry file.
- **Production-safe by construction** — `apply: 'serve'` means Vite drops the plugin entirely from
  `vite build`. There is no env gate to forget; instrumentation cannot reach a production bundle.

Usually installed via the umbrella package and imported from its `/vite` subpath:

```bash
npm i -D @syrin/iris
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { iris } from '@syrin/iris/vite';

export default defineConfig({
  plugins: [react(), iris()],
});
```

That is the entire integration — no entry-file edit, no Babel-plugin wiring, no env gating.
`npx @syrin/iris init` adds this line for you automatically in a Vite project.

## Options

```ts
iris({
  port, // bridge WebSocket port; baked into connect() only when non-default
  session, // stable session label (defaults to the SDK's auto id)
  token, // auth token forwarded to connect() when the bridge requires one
  sourceMapping, // default true — stamp data-iris-source (harmless on React <=18)
  inject, // default true — auto-inject iris.connect()
});
```

MIT.
