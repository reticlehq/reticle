### Fixed

- **`reticle update` installed the app's SDK with npm inside a pnpm (or yarn, or bun) workspace.** A workspace member keeps its lockfile at the workspace root, so reading only the app's own folder found no lockfile and fell back to npm. It now reads the enclosing workspace root too, and installs with the manager the workspace actually uses.
