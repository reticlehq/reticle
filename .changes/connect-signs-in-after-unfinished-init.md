### Fixed

- **`@reticlehq/server` — `reticle connect` stopped after `init`'s warnings on its first run and never signed in.** On a fresh project `connect` runs `init` first, and a setup that did not finish (a dependency install that failed, a connect snippet to paste by hand) exited the whole command before sign-in, with nothing saying to run it again. It now says the setup did not finish, signs in and links anyway, and still exits non-zero.
