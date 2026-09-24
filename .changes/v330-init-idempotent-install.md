---
'@reticlehq/init': patch
---

`init` no longer runs a dependency install over a project that already has the packages, and it believes a project that declares its package manager.

Reported from the field: `init` on an already-instrumented npm-workspaces project launched a pnpm dependency migration, moved the existing `node_modules` to `.ignored`, and broke `next dev`. Moving somebody's installed tree aside is not something a scaffolder may do to a working checkout.

The redundant install is the step that touches the tree, so not running one that nothing needs is the fix that matters. `npm i -D pkg@3.2.0` writes `^3.2.0`, so on every later run the pinned `3.2.0` failed a string comparison against the range npm had just created and init re-installed for ever - while claiming to be idempotent. Only the forms a package manager writes by itself are read as satisfied; anything else still installs, because a false "already" leaves somebody with no SDK while a redundant install only costs time.

`packageManager`, the corepack field, is now read and outranks every other signal. It is the project SAYING which manager it uses, where a lockfile is evidence of what was run once and an installed tree is evidence of what was run last, and corepack refuses to run a different one on the project's behalf.
