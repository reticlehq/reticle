### Fixed

- **`@reticlehq/init` — generated Vite dev modules now compile without ambient `vite/client` types.** New `reticle-dev.ts` files carry merge-compatible declarations for `import.meta.env.DEV`, without modifying the application's tsconfig or its environment declarations. The production guard and JavaScript generation are unchanged, and existing user-edited dev modules remain untouched. Addresses the generated-module TypeScript failure in [#998](https://github.com/reticlehq/reticle/issues/998).
