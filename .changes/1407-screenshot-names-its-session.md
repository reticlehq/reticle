### Fixed

- **`@reticlehq/server`: a screenshot of one session never carries the driven tab's pixels.** While `reticle drive` was alive, `reticle_screenshot` and `reticle_visual_diff` for another session saved a picture of the driven tab and reported success. The driven browser is now used only for the session it is driving; any other session is pictured through its own lease, or refused with `no-visual-provider`. Closes [#1407](https://github.com/reticlehq/reticle/issues/1407).
