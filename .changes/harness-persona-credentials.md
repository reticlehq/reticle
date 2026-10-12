### Fixed

- **`@reticlehq/server` — the Harness ignored the credentials a persona gave it.** Asked to sign in "as ana@acme.test, password: hunter2", it typed its default address and got a 401, so every journey behind a login failed; and the persona travelled verbatim, so the password was stored with the synced run. The email and password a persona names now fill the sign-in fields on this machine (before any `RETICLE_SECRET_*` value, which comes before the platform's default), and the password is redacted from the text that is sent and stored.
