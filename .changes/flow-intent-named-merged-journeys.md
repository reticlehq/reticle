### Added

- **`@reticlehq/server` + `@reticlehq/core`: a driven journey is saved once, named by its intent.** The `intent` given to `reticle_act_and_wait` becomes the saved flow's `intent` and its name. Auto-saved flows that start on the same page and take the same steps merge into one file instead of one per session; the existing flow keeps its name and fields, the new drive only fills gaps, and hand-named flows are never touched.
