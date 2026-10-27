### Fixed

- **`@reticlehq/engine` — a `not` inside `allOf` failed when its inner element was absent.** This occurred on a throttled tab. The absent inner element made the `not` unreadable. When a sibling clause found an element, the engine removed the throttle note from the `not` but did not apply the negation again. The `not` then failed, and `allOf: [{ text: "Saved" }, { not: { text: "Error" } }]` gave `no` on a page that showed "Saved" and no "Error". The engine now applies the negation again after it removes the note, also for a nested `not`.
