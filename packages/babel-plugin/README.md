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

After this, `reticle_inspect` returns `component.source = { file, line, column }`. Only host elements (`<div>`, `<button>`, …) are stamped; components are left untouched. MIT.
