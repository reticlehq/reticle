### Fixed

- **`@reticlehq/server` — linking named the dashboard project after the folder when `.reticle.json` carried a `projectId` written by hand (`persona-oss`, `dashboard-drive`).** Only `init`'s `<name>-<hash>` form was read. A hand-written id is the name now, so local flows and the dashboard project share one name.
- **`@reticlehq/server` — the Harness credits refusal linked to the API's origin (`…/settings?group=billing` on the API host), which 404s wherever the API and the console are different hosts.** It uses the plan page the platform names in `/v1/model/config` (`planUrl`); the HUD's "Start your trial" line uses the console the project is linked to.
