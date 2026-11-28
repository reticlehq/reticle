# @reticlehq/terminal

The Reticle realm for the terminal. It runs a command-line program, watches what it prints and what it does to the filesystem, and gives a verdict on a claim. The program needs no change.

```bash
npx -p @reticlehq/terminal reticle-terminal --expect "dist/index.js is written" --path dist/index.js -- npm run build
```

- **The claim comes first.** `--expect` says what should become true, and `--path` names the file that shows it.
- **The evidence is what happened.** The output, the exit code, and each file that was added, changed or removed, from a snapshot of the folder before and after the command.
- **The verdict is `yes`, `no` or `unknown`.** An exit code of 0 is not a pass by itself: the file that the claim names must show the change.
- `--json` prints the record for an agent. `--cwd <dir>` runs the command in another folder.

`@reticlehq/computer` uses the same file snapshot to report the files that a desktop action wrote.

[Reticle](https://github.com/reticlehq/reticle) · Apache-2.0
