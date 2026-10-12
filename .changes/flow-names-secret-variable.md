### Fixed

- **A saved flow names the variable that supplies each redacted value.** A password step was saved as `<redacted: supply at replay>` and nothing else, so a teammate opening the flow (or its page on the dashboard) could not learn how to replay it. The step now carries, under `secret`, the name of the `RETICLE_SECRET_<FIELD>` variable beside the placeholder; replay drops it before the step reaches the page.
