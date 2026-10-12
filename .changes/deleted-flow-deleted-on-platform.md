### Fixed

- **A flow deleted on this machine is deleted on the platform.** The platform does not infer a deletion from a name missing in the synced set (another clone may still hold it), so a flow removed here stayed listed and counted there. The sync now remembers which flows the platform took from here and, for one gone from disk, calls `DELETE /v1/flows/:name?projectId=…` with the project's key, once.
