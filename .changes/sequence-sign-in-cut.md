### Fixed

- **`@reticlehq/server` — an auto-saved flow no longer starts behind a sign-in made with one `reticle_act` call.** A journey is cut after a sign-in, so a saved flow does not begin at the login form. A sign-in sent as one sequence (fill Username, fill Password, click Sign in) was not seen as one, because only a fill at the top of a step counted. The journey after it was saved from the login form, and a replay that starts signed in found no Username field: `unknown` on a working app. A sequence that fills a password now counts as a sign-in.
