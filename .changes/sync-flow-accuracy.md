### Fixed

- **`@reticlehq/server` — a flow with a namespaced name (`onboarding/signup`) never reached the dashboard.** Sync read the flows folder one level down, and a namespaced name is a folder of its own, so every such flow stayed on the machine while each cycle reported ok. Flows are now read at any depth.
- **`@reticlehq/server` — each flow save re-sent every saved flow.** Five flows saved a few seconds apart went up 5, 4, 3, 2 and 1 times, and on a real repo every save carried all 814 flows (about 1.3 MB) while the platform stamped each one as updated. A flow now goes when it changed, once; a flow deleted here and saved again goes again.
- **`@reticlehq/server` — work saved while offline waited minutes after the network came back.** Each save's failed sync doubled the retry wait, so ten items saved during 30 s offline reached the dashboard 216 s after reconnecting. Unsent work now retries every minute; only an idle machine backs off.
