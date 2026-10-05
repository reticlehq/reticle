### Fixed

- **`@reticlehq/init`: `init` in a directory with no app below it wrote `.reticle.json` anyway.** It said to run `init` from the app's directory, then wrote a config into the one it had just called wrong and printed a script-tag snippet nobody was meant to paste. A daemon later started there scoped itself to a project that is not there. It now stops at the message and writes nothing. Closes [#1366](https://github.com/reticlehq/reticle/issues/1366).
