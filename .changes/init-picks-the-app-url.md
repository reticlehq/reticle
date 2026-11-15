### Fixed

- **`reticle init` — in a workspace whose root `dev` script also starts an API, init checked the API instead of the app.** Since 3.10.3, init runs the workspace root's `dev` script when it also starts the app. That script started the API too, the API announced its URL first, and init said "the SDK is NOT in the page" about the API and exited 1, while the app served correctly. For a root script, init now waits for the URL that serves an HTML page, and prefers the URL on the app's expected port or on the output line that names the app. An API's JSON is never taken for the app.
