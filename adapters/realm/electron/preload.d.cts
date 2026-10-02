/**
 * Types for the preload entry, which is a SIDE-EFFECT module and exports nothing.
 *
 * `arethetypeswrong` failed this package in CI with "Import resolved to JavaScript files, but no
 * type declarations were found" on `@reticlehq/electron/preload`, across node16-CJS, node16-ESM and
 * bundler. `./main` already had `main.d.cts`; this entry never did, so a TypeScript Electron app —
 * which is most of them — got an untyped resolution for one of the package's two entries.
 *
 * The declaration is empty because the runtime surface is empty. `preload.cjs` runs
 * `contextBridge.exposeInMainWorld` and returns nothing: it is named in a `webPreferences.preload`
 * path, or required for its effect, and never destructured. Declaring a shape here would be
 * inventing an API to satisfy a checker, which is worse than the untyped resolution it replaces.
 *
 * What the preload actually installs is on `window`, in the RENDERER, under the global the contract
 * names. That is a different type surface and it belongs to whatever reads it, not here.
 */

export {};
