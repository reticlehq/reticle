### Fixed

- **`@reticlehq/server`: a page that arrives with no pairing token is told what happened.** The bridge refused it with "no pairing token on the page", which named the symptom only. It now says the build did not substitute the token and to restart the dev server, which re-runs that substitution. Raised in review of #1047 by @vaibhav8a.
