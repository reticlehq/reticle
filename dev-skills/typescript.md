# dev-skills/typescript.md — TypeScript Rules & Patterns

**Open when:** any TypeScript question or pattern. (Maps to Foundation II.11.)

## Equality & null

```ts
if (a === b) {
} // ALWAYS === / !== — eqeqeq is an error
const name = user?.name ?? 'Unknown'; // optional chain + ??, never user!.name
```

## No `any` — narrow at the boundary, trust types inside

```ts
const raw: unknown = JSON.parse(text); // boundary input is unknown
const msg = IrisMessageSchema.parse(raw); // zod validates -> typed from here on
```

All cross-boundary data (WS messages, MCP tool args, network capture) is validated with a
zod schema from `@iris/protocol` and only then used as a type. `no-explicit-any` and the
`no-unsafe-*` rules are errors.

## Constants, not unions of literals scattered around

Define a constant object `as const` + a derived type with the same name (see
`packages/protocol/src/constants.ts`). One declaration gives you the values and the type.

```ts
export const EventType = { DOM_ADDED: 'dom.added' /* ... */ } as const;
export type EventType = (typeof EventType)[keyof typeof EventType];
```

## Strict config is on — work with it, don't fight it

`noUncheckedIndexedAccess` means `arr[0]` is `T | undefined` — check it. `strict-boolean-expressions`
means `if (str)` is an error for strings/numbers — write `if (str.length > 0)` /
`if (n !== 0)`. `exactOptionalPropertyTypes` means `{ x?: T }` ≠ `{ x: T | undefined }` —
omit the key rather than passing `undefined`.

## ESM hygiene

`verbatimModuleSyntax` is on: use `import type { X }` for type-only imports, and include
the `.js` extension on relative imports (`./constants.js`) — this is correct for NodeNext/
bundler ESM even though the source file is `.ts`.

## `eslint-disable` policy

Every suppression needs a `// reason` comment on the line directly above it. Pre-commit
rejects bare disables. Prefer fixing the code over suppressing.

## Hook naming

Name a function `useX` **only** if it calls a React hook. A non-hook helper named `useX`
trips `react-hooks/rules-of-hooks` the moment it's used in a callback. Use `build/get/apply/
handle` for plain utilities.
