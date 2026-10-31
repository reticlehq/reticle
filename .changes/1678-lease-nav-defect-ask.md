### Fixed

A lease navigation to a URL where nothing is listening no longer asks the agent to report a Reticle defect. The refused case gets a concrete recovery hint (start the app, then acquire again); the timeout and certificate-refused cases are now marked self-recovering so no second hint is appended.

Closes #1678
