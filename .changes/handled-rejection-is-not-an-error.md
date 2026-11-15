### Fixed

- **`@reticlehq/browser` — a promise rejection the page handled was reported as an uncaught error.** After a Next.js server action that redirects, Reticle reported `NEXT_REDIRECT` as an error. Next.js handles that rejection itself: its listener calls `preventDefault()` and navigates, and the browser console stays clean. Reticle read the rejection before the page's listener ran, so a clean-console check failed on correct code. Reticle now decides after every listener has run, and a rejection the page cancels is not an error. A rejection nobody handles is still reported.
