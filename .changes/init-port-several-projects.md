### Fixed

- **`@reticlehq/server` — `reticle init` wired a new app to another project's daemon.** Init moved a project off the default port only when the daemon there served exactly one other project. A daemon that served two was kept, so the new app ran on a daemon rooted in another repository and linked to that repository's cloud project. Init now gives the new app its own port, and writes `port` into `.reticle.json`, whenever the daemon on the default port serves other projects and not this one.
