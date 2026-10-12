### Fixed

- **`@reticlehq/server` — a Harness plan link could open as "We could not find that plan".** The `planUrl` in a Harness answer now names its project (`?project=<id>`), so it opens under the right project whatever project the dashboard last showed.
- **`@reticlehq/server` — a held network check did not say which request it saw.** Only a failed check kept the requests of its window, so a passed one reached the share page as "a POST request was seen". A held network check now keeps the request that answered it (method, URL, status).
- **`@reticlehq/server` — a Harness flow or run could be titled "Autonomous drive of …" or "Harness drive".** A recording saved at the end of a plan journey with no persona now carries the journey's own text, and a drive nobody named a journey for is called "Exploring the app".
