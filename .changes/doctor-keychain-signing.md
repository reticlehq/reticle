### Added

- **`reticle doctor` says when macOS will ask for the keychain password.** On macOS, for a Tauri project, doctor reads the signature of the dev build Reticle drives (`codesign -dv`) and, when it is ad-hoc or unsigned, or signed by another team than the copy in `/Applications`, says once: macOS ties keychain items to the app's signature, so this build's keychain reads will ask for your password; sign it with your release identity (`APPLE_SIGNING_IDENTITY` / `signingIdentity`) or use a separate keychain service in dev.
