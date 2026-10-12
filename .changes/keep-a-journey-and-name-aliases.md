### Fixed

- **The "keep it as a regression flow" advice after a proved journey was a dead end.** It named `reticle_flow_save { saveAs }`, which refused without a recording. A proved journey is now held as the stopped recording `last-journey`, and the advice names `reticle_flow_save { flowName: "last-journey", saveAs }`, which saves exactly what was driven.
- **`reticle_flow_save` accepts `name` (and `recordingName`) for `flowName`, and saves the one stopped recording when none is named; `reticle_record` accepts `name` for `recordingName`.** Each alias used is named back as `normalized`; with several recordings stopped, nothing is picked.
