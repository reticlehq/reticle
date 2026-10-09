### Changed

- **The installer ends by saying Reticle is not in your app yet.** It used to finish by driving Reticle's own demo app and printing "one session connected" and "verified: yes", which read as Reticle being wired into the reader's app. It now closes with "Reticle is installed on this machine. It is not in your app yet" and names `reticle init` in the app's folder as the next step. `reticle tutorial --run` still shows the demo, and says whose app it drove.
