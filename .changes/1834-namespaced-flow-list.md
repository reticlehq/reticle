### Fixed

- **`verify change` could not replay a flow `affected` had just named.** A flow saved as `onboarding/signup` was listed under that name by one path and under `signup` by the other, so the replay reported it absent. Listing now keeps the namespace, and both paths use that name. See [#1834](https://github.com/reticlehq/reticle/issues/1834).
