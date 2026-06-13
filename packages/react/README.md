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

Requires [`@iris/browser`](https://www.npmjs.com/package/@iris/browser). Source mapping uses
React's dev `_debugSource` (on by default in Vite/Next/CRA dev). See the
[main README](https://github.com/iris-mcp/iris). MIT.
