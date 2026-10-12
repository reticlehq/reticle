### Fixed

- **`@reticlehq/server` — every Harness plan run swept the whole app afterwards, "Sign out" included.** The crawl after a plan's journeys pressed the sidebar's "Sign out", clicked stale controls on the sign-in page, and left the next run signed out. The crawl (and `reticle_verify {action:"crawl"}`) now never presses a sign-out or log-out control and lists it as not pressed; destructive controls stay behind the action gate as before. A plan run sweeps the app only when it surveyed it, so a run on a fresh map (under a day old) leaves the app alone.
