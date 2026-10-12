### Fixed

- **An exported `RETICLE_API_KEY` that is not used is said.** In a linked repo the key `reticle connect` stored wins over the environment, as documented, but `RETICLE_API_KEY=… reticle sync` and `reticle verify` used the stored key without a word. Both now say the exported key was not used, and why.
