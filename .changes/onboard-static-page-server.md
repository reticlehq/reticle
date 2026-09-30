### Fixed

- **`@reticlehq/server`: a plain HTML page with no dev server connects on the first `init`.** A directory holding only `index.html` used to be wired and then stop at "No dev command … start the app yourself and pass --url". `init` now serves the directory itself on a loopback-only port, hands that server over like any dev server, and proves the connect.
