### Fixed

- **`reticle init` — flag existing Next.js ReticleDev components missing SDK version with NOTICE.** Existing installs that connect without passing `NEXT_PUBLIC_RETICLE_SDK_VERSION` now receive an informative NOTICE instead of silent omissions, keeping `init` at exit 0 while ensuring port rewrites continue to apply cleanly. Closes [#1150](https://github.com/reticlehq/reticle/issues/1150).
