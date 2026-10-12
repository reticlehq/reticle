### Fixed

- **`@reticlehq/server` — re-linking a folder to another project sent the old project's flows anyway.** `reticle connect --project <other>` answered "sent 5 flow(s)" and "5 flows made before this folder was linked … stay on this machine" in the same answer, and the new project listed the old one's flows. The flows read from disk are rebuilt on every read, so the held-back list never matched the list being sent. The flows are now read once and split by when they were made, so the old ones really stay until `--move-history`.
