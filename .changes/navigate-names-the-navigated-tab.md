### Fixed

- **`reticle_navigate { sessionId }` could report a different tab.** When another tab on the same app, such as a lease, reached the same URL during the wait, the result named that tab. Later calls then acted on the wrong tab. Only the navigated tab, or the new document it loads, now counts as the arrival. A tab that was connected before the navigation, or that claims another session identity, does not.
