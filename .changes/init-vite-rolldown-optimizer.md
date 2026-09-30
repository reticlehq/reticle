### Fixed

- **`@reticlehq/init` — Nuxt and Astro on Vite 7+ warned about `optimizeDeps.esbuildOptions` on every dev start and build.** `init` wrote an esbuild target into the framework config whatever Vite was installed, and Vite 7 moved its dependency optimizer to rolldown and deprecated that key (seen on Nuxt 4.5 / Vite 8). `init` now reads the installed Vite and writes the target only where esbuild still runs the optimizer; re-running `init` takes the key back out of a config an older version patched.
