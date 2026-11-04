### Deprecated

- **`@reticlehq/server` — four commands are now flags of the command that did the same work.** `affected` is `gate --list`, `license` is part of `status`, `rollback` is `update --rollback`, and `restart` is `serve --restart` (`--force` too). Each old name still works for this release and prints one line that names the new spelling. `status` shows the license when a key is set, and `status --json` always carries it. Closes [#2191](https://github.com/reticlehq/reticle/issues/2191).
