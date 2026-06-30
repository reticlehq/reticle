# @reticle/react

React adapter for [Reticle](https://github.com/reticlehq/reticle). Walks the React fiber tree so `reticle_inspect` can map a DOM element back to its **component stack and source file** — the bridge from "the agent sees a bug in the UI" to "the agent edits the right file".

```bash
npm i -D @reticle/react
```

```ts
import { install } from '@reticle/react';
if (import.meta.env.DEV) install(); // call before reticle.connect()
```

Requires [`@reticle/browser`](https://www.npmjs.com/package/@reticle/browser).

**Source-file mapping:** on React ≤18, uses dev `_debugSource` automatically. On **React 19** (`_debugSource` removed), add [`@reticle/babel-plugin`](https://www.npmjs.com/package/@reticle/babel-plugin) to your dev build — the adapter then reads its `data-reticle-source` stamp so `reticle_inspect` returns `component.source = { file, line, column }`.

See the [main README](https://github.com/reticlehq/reticle). MIT.
