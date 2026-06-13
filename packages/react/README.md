# @syrin/react

React adapter for [Iris](https://github.com/syrin-labs/iris). Walks the React fiber tree so
`iris_inspect` can map a DOM element back to its **component stack and source file** — the
bridge from "the agent sees a bug in the UI" to "the agent edits the right file".

```bash
npm i -D @syrin/react
```

```ts
import { install } from '@syrin/react';
if (import.meta.env.DEV) install(); // call before iris.connect()
```

Requires [`@syrin/browser`](https://www.npmjs.com/package/@syrin/browser).

**Source-file mapping:** on React ≤18, uses dev `_debugSource` automatically. On **React 19**
(`_debugSource` removed), add [`@syrin/babel-plugin`](https://www.npmjs.com/package/@syrin/babel-plugin)
to your dev build — the adapter then reads its `data-iris-source` stamp so `iris_inspect`
returns `component.source = { file, line, column }`.

See the [main README](https://github.com/syrin-labs/iris). MIT.
