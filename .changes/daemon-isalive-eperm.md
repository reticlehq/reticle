### Fixed

- **`@reticlehq/server` — a live daemon could be taken for dead, and a second one started on its port.** The check that a daemon's process is alive read every error as "dead". On Windows, a daemon that WMI started can refuse the check with a permission error, which means the process exists. The next start then reported the daemon as died, and started a second daemon that could not bind the port. A permission error now counts as alive.
