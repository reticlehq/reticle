/**
 * Webpack pre-loader (wired by `withReticle`) that stamps `data-reticle-source` on JSX/TSX before
 * next-swc-loader compiles it. Consumed by webpack by path, not imported as an API — this declaration
 * exists so the subpath is typed. `this` is a webpack LoaderContext (kept as `unknown` to avoid a
 * `webpack` type dependency in a package that only ships a `.cjs` loader).
 */
declare function reticleNextLoader(this: unknown, source: string, inputMap?: unknown): void;
export = reticleNextLoader;
