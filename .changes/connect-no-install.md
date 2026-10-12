### Fixed

- **`reticle connect --no-install` no longer installs, and `init --no-install` no longer warns.** `connect` ran its init half with the install on whatever the flags said, and its cloud half then refused `--no-install` as a usage error. The flag now reaches the init half and the cloud half accepts it. Under `--no-install`, the install step is shown as skipped (with the command to run yourself) instead of "[⚠] Install dependencies".
- **Setup no longer tells `connect` there is "no --url"** when the person passed the platform's `--url`: it says no app url was given, naming `reticle init --url <app>`.
