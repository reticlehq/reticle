### Fixed

- **`@reticlehq/server` — the Harness repeated clicks that did nothing.** A drive clicked the logo four times on the page it leads to. An action that changed nothing on the page (no content, request, route or signal) is no longer run again on the same control until something else moves the page; the driver is told to take the next step instead. A drive is also told that limits in its focus, such as reading a list "without opening a run", bind the whole drive.
