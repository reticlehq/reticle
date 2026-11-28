### Security

- **`@reticlehq/server` — `reticle open` opens only a web address.** The launcher of each system (`start` on Windows, `open` on macOS, `xdg-open` on Linux) also runs a program or opens a file when it is given one. An address that does not start with `http://` or `https://` is now refused, with the reason, and nothing is started.
- **`@reticlehq/computer` — the Linux sandbox image is pinned.** `reticle-computer --sandbox linux` builds from `ubuntu:24.04` pinned by its digest, and installs Node from nodejs.org after a check of its SHA-256. Before, it ran a setup script from the network.
- **Dependencies:** `next` 15.5.29 and `minimatch` 11.0.1, for four moderate advisories (GHSA-7qx7-33qx-rqx2, GHSA-f3mh-rxg3-f5g2, GHSA-pc58-hwjq-p385, GHSA-g3hv-75wg-m249). Neither is in a published package: `next` is a peer dependency, and `minimatch` comes from tooling.
