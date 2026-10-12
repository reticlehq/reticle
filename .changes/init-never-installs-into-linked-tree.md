### Fixed

- **`init` (and `connect`, which runs it) never installs into a `node_modules` that is a link.** An app whose `node_modules` was a symlink to a workspace's tree had it replaced by a fresh tree when `init` ran the package manager. When `node_modules` is a link, the install step is now skipped and names the command to run where the link points.
