### Fixed

- **`@reticlehq/init` — Nuxt and Vite + Vue were labelled "vue is UNVERIFIED".** Both are scaffolded from scratch by the install gate on every change, so the setup is proven there; only the drive is not. The notice now reads "vue setup verified, drive unverified" for the stacks the gate covers, and keeps "UNVERIFIED" for the ones it does not (Vue under Astro, for one).
