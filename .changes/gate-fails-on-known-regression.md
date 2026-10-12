### Fixed

- **`@reticlehq/server` — `reticle gate` ignored a regression the dashboard knew about.** In a linked repo the gate now asks the platform which flows passed before and are broken now, and fails with `3`, the code `reticle runs regression` uses, so the gate is the one command CI needs. Its exit `2` for a project with no saved flows now prints that nothing was checked, that this is not a failure of the change, and how to record a flow.
