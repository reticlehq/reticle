### Fixed

- **`@reticlehq/browser` — with the HUD exposed and shown, a text check passed on the HUD's own words.** The act strip writes `Finding "<your text>"` for each call. With `exposePresenter` on and the HUD shown, `reticle_assert` and `reticle_act_and_wait` with a visible-text `until` came back `verified: "yes"` on text the app never rendered, and an `absent` check failed on it. The act strip line is now never a match source, like the Agent Log and the Harness log.
