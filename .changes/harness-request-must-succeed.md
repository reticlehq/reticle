### Fixed

- **A Harness sign-in that answered 401 is no longer a check that held.** The Harness declared "a POST to /api/login" with no status, and a request claim with no status is met by any answer, so a refused sign-in counted as proved. A request the Harness declares must now succeed unless its claim names the status it expects.
