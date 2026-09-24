---
'@reticlehq/browser': patch
---

Two ways Reticle's own panel got in front of the app under test, both reported from the field by drivers running outside Reticle.

The first-connect tour no longer mounts in a browser under automation. Its scrim takes `pointer-events: auto` on purpose, so a driver's click landed on the scrim instead of the app and the run stalled until somebody attached a debugger. Two guards already existed and neither covers this case: `isDriving()` reads false at page load by construction, and the URL stamp only marks pages Reticle itself opened, which a driver launching its own browser context never carries. `navigator.webdriver` is that question asked directly, and the same discriminator the HUD already uses to drop its action pacing under automation.

A HUD somebody minimised now stays minimised across a reload. Minimising the panel to reach a control underneath it, reloading, and finding it back over that control was reported twice; auto-open is a preference about session start, not an answer to a question somebody already answered by hand. Remembered per tab, so it survives the reload it exists for and nothing longer.
