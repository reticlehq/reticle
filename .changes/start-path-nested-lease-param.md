### Fixed

- **`@reticlehq/engine` — a saved start page no longer carries Reticle's session id inside an app's own parameter.** A signed-out tab that an app sends to its login page carries the page it came from, for example `/auth?redirect=%2F%3F__reticle_session%3D…`. The recorded start page kept that, and a replay that signed in came back to a page with an old session id. Reticle's own parameters are now taken out of a parameter's value too. A value with none of them keeps its exact spelling.
