# @iris/babel-plugin

Stamps `data-iris-source="file:line:col"` on JSX host elements so
[`@iris/react`](https://www.npmjs.com/package/@iris/react) can map a DOM node back to its
**source file** — needed on React 19, which removed `_debugSource`. Dev-only.

```bash
npm i -D @iris/babel-plugin
```

**Vite** (`vite.config.ts`):

```ts
import react from '@vitejs/plugin-react';
import irisSource from '@iris/babel-plugin';

export default defineConfig({
  plugins: [react({ babel: { plugins: [irisSource] } })],
});
```

**Babel** (`babel.config.js`, dev only):

```js
module.exports = { plugins: [require('@iris/babel-plugin').default] };
```

After this, `iris_inspect` returns `component.source = { file, line, column }`. Only host
elements (`<div>`, `<button>`, …) are stamped; components are left untouched. MIT.
