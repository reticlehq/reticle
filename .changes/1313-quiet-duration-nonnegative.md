### Fixed

- **`@reticlehq/server` — dev-server quiet time could briefly be negative on macOS.** Fractional filesystem modification times can be slightly ahead of the integer millisecond clock. Quiet time is now clamped to zero, keeping setup diagnostics and the macOS platform gate stable.
