### Fixed

- **The one-line installer looked hung while npm worked.** `npm install -g` draws its progress bar only onto a terminal, and a `curl … | sh` pipeline never gives it one — so from "Installing @reticlehq/server..." until npm's final summary there was no output at all. On a cold cache that is a silent minute on the very first thing anybody runs, and it was reported as the installer sticking. Both installers now say the silence is expected before handing over to npm.
