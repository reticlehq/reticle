### Fixed

- **`@reticlehq/server` — on some Windows machines, every daemon that 3.8.1 started died at once.** 3.8.1 starts the Windows daemon through WMI, so that an agent's Job Object cannot kill it. On some machines the daemon that WMI started died immediately, so Reticle never came up. The same machines worked with the detached start of 3.8.0. Now a daemon that WMI started must stay alive for one second. If it dies, Reticle starts the daemon detached, as 3.8.0 did.
