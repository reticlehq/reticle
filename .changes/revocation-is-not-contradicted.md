### Fixed

- **A working revocation is no longer graded `no`.** A member removed from a workspace was sent to the sign-in page with "You were removed from …", and an assert on that page came back `no / signal-contradicted` "even though the assertion passed": the intended `401` beside Reticle's own `reticle:hydration-complete` was read as the app claiming success over a failed write. Signals Reticle's instrumentation fires are no longer read as the app's claims. A success the app itself announces over a failed write, and a UI that moves forward while its write fails, are still caught.
