# @iris/react

React adapter for [Iris](https://github.com/iris-mcp/iris). Walks the React fiber tree so
`iris_inspect` can map a DOM element back to its **component stack and source file** — the
bridge from "the agent sees a bug in the UI" to "the agent edits the right file".

```bash
npm i -D @iris/react
```

```ts
import { install } from '@iris/react';
if (import.meta.env.DEV) install(); // call before iris.connect()
```

Requires [`@iris/browser`](https://www.npmjs.com/package/@iris/browser).

**Source-file mapping:** on React ≤18, uses dev `_debugSource` automatically. On **React 19**
(`_debugSource` removed), add [`@iris/babel-plugin`](https://www.npmjs.com/package/@iris/babel-plugin)
to your dev build — the adapter then reads its `data-iris-source` stamp so `iris_inspect`
returns `component.source = { file, line, column }`.

See the [main README](https://github.com/iris-mcp/iris). MIT.
