### Fixed

- **A dev server in a container can now be set up.** Everything below the CLI assumed the daemon and the dev server share a filesystem. When they do not — Docker, a devcontainer, WSL — the build plugin looked for the pairing token in `$HOME` inside the container, found nothing, minted its own, and every page was refused with `authentication failed`, which named none of that. This now shows up three times over: `reticle init` warns before it happens if it sees a container file near the app, the daemon explains it when a page from a wired project is refused, and the refusal itself says the token is wrong rather than that something failed. The troubleshooting page carries the compose snippet.

- **`reticle init --help` answers with usage instead of an error.** `--help` was recognised only as the first word, so putting it after a command reached that command's own flag parser, which answered `unknown argument '--help'` and exited 1. The usage text was printed underneath, so the question was answered — as a failure. It now works anywhere in the command line, including for `login`, `link`, `push` and the other commands that talk to the cloud, where asking for help previously ran the command and tried to reach the network.

- **`reticle version` prints somewhere a script can read it.** The version existed only as a diagnostic line on the error stream, so `V=$(reticle version)` came back empty — the shape people reach for when filling in a bug report. The bare version now goes to standard output as well.

- **The build plugin and the CLI look the same distance up for `.reticle.json`.** The plugin walked fifty directories where the CLI stops at six, so a dev server started somewhere unexpected could adopt a distant project's identity and be refused. Both stop at six now. The `package.json` search still goes further, because a package name only ever helps build an id rather than adopt one.

- **Registering a project no longer forgets the others.** Reticle keeps one file listing every project it knows about. If it could not read that file it started a fresh one, so a single unreadable file became a file with one project in it — during `reticle init`, which is what you run right after upgrading. A file it does not recognise is now left exactly as it is.

### Added

- **A live drive leaves a run behind.** Driving an app produced verdicts that stayed on your machine: only replaying a saved flow ever wrote a run, so the work you actually did was invisible to anything downstream. A session now folds into the same artifact a replay writes. A drive that produced verdicts and could not resolve any of them writes a run saying exactly that, rather than nothing at all — an empty list looks identical to never having driven, and "nothing could be proved" is the thing most worth seeing. A drive across several page reloads writes one run, not one per reload.
