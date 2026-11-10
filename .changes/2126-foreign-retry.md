### Fixed

- **`reticle open` right after `reticle restart` no longer refuses a port its own daemon still holds.** A FOREIGN reading seconds after the restart is retried once while the pid `restart` recorded is alive; a stranger on the port is still never retried. Closes [#2126](https://github.com/reticlehq/reticle/issues/2126).
