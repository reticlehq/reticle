### Fixed

- **HUD — a refused API key read "0 waiting".** The sync chip now says **Key refused**, with the platform's own reason on hover ("You were removed from Acme.", or a key whose owner lost the project), and the sync sentence an agent reads says "the last push was refused: …" instead of the raw `status 401` record.
