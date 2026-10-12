### Fixed

- **`@reticlehq/server` — `connect` gave one project two ids.** `.reticle.json` said `nina-app-ef9029ee` while the platform project it created was `nina-app`. A project `connect` creates by default now asks the platform to keep the folder's own id (the name shown stays the readable one), and a platform project already holding that id is the one linked. A platform that does not know the field answers with its own id, which is linked as before; a named `--project` and an already-linked folder are unchanged.
