### Fixed

- **`reticle stop` stops a daemon whose pid file is gone.** It answered `reticle_daemon_not_running` for a daemon still listening on the port, because it only read the pid file. With no pid on record it now asks the port: a Reticle daemon that answers is stopped the way `reticle kill` stops one, confirmed as Reticle's before it is signalled.
