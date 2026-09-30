### Fixed

- **`@reticlehq/init` — the "Containerised dev server" notice fired on production-only Dockerfiles.** React Router's own template ships a multi-stage production Dockerfile, so every React Router install was told to rebuild an image and mount the pairing token for a dev server that runs on the host. The notice now appears only when a Dockerfile or compose file actually runs the dev server (the app's dev script, `npm run dev`, `vite`, `next dev`, `ng serve`, …), or for a devcontainer.
