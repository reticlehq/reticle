### Fixed

- **`@reticlehq/server` — after a reboot, the daemon could fail to start because the OS gave its old pid to another program.** A daemon's pidfile survives a reboot. On Windows, the old pid then belonged to an unrelated Bluetooth service. The port was free, but `reticle serve` saw that the pid was alive and skipped the start, so no daemon came up. A pidfile now names a live daemon only when its pid is alive and the file was written after the last boot. The stale-pidfile sweep uses the same rule.
