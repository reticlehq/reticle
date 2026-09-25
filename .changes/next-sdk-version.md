### Fixed

- **`@reticlehq/init`: the Next.js connect file passes the SDK version to `connect()`.** `withReticle` already published `NEXT_PUBLIC_RETICLE_SDK_VERSION`, but the generated `ReticleDev` never read it. So a version skew on Next always read as "a page on an unknown older wire contract" instead of naming the version to upgrade. Run `init` again, or add `sdkVersion: process.env.NEXT_PUBLIC_RETICLE_SDK_VERSION` to the `connect()` call yourself.
