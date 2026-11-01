### Fixed

- **`@reticlehq/server` — a step inside a recorded sequence finds its control as a single step does.** A sub-step looked through every control of its role and took the first one. It ignored the recorded position among controls of the same name, and it read a control with no name as "any control of the role". A nameless file input in an import form got the upload aimed at the first named button, and the replay failed on a working app. Sub-steps also keep their recorded position when the sequence is saved. Closes [#2084](https://github.com/reticlehq/reticle/issues/2084).
