# @reticlehq/babel-plugin

Stamps `data-reticle-source="file:line:col"` on JSX host elements so [`@reticlehq/react`](https://www.npmjs.com/package/@reticlehq/react) can map a DOM node back to its **source file** — needed on React 19, which removed `_debugSource`. Dev-only.

```bash
npm i -D @reticlehq/babel-plugin
```

**Vite** (`vite.config.ts`):

```ts
import react from '@vitejs/plugin-react';
import reticleSource from '@reticlehq/babel-plugin';

export default defineConfig({
  plugins: [react({ babel: { plugins: [reticleSource] } })],
});
```

**Babel** (`babel.config.js`, dev only):

```js
module.exports = { plugins: [require('@reticlehq/babel-plugin').default] };
```

After this, `reticle_inspect` returns `component.source = { file, line, column }`. Only host elements (`<div>`, `<button>`, …) are stamped; components are left untouched.

**Opting one file out:** a file whose first non-empty line is `// @reticle-ignore` (or `/* @reticle-ignore */`) is not stamped at all. Whole file, first line — the reasons to opt out are file-shaped, and a marker that works from anywhere is a marker nobody can find. Apache-2.0.
