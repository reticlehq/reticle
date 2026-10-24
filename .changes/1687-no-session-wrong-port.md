### Fixed

A wired project whose dev script names a port that is not currently listening now gets `START_DEV_SERVER` (not `OPEN_APP`) from the no-session probe. Opening a port that nothing serves gives the wrong error; starting the dev script first is the right step.

Closes #1687
