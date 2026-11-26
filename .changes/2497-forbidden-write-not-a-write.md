### Fixed

- **`@reticlehq/server` — a flow that forbids a write request was treated as a flow that sends one.** A navigation flow that checks that no POST goes out (`net` with `count: 0`, or a `net` check inside `not`) was marked as a write flow. The replayability report then said it changes real data, and `skipWrites` held it back, so a certify run did not check it. A forbidden request no longer makes a step a write. A `not` over `count: 0` still does.

  A flow saved before this fix keeps `"writes": true` on such a step, and `skipWrites` still holds it back. Reticle cannot tell that mark from a step that sent a write request while it was recorded, so it keeps the mark. The report now names the forbidden request and tells you to remove `"writes": true` from the step in the flow file if the step sends no write request. Closes [#2497](https://github.com/reticlehq/reticle/issues/2497).
