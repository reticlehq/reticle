# `cli-smoke` — integration proof for `@reticlehq/cli-realm`

A command-line tool that can be put into each behaviour the conformance suite asks for, so the CLI realm can be scored against the specification's own scenarios on a surface with **no screen and no network**.

That combination is the point. Both existing conformance subjects are pages — a browser and an Electron shell — so the claim that the adjudicator is realm-blind has never been tested against a subject that has neither a DOM nor a request to intercept. This is the first one.

## Two scenarios reachable here and nowhere else

- **`consequence-already-true`** is the one adjudication ground no run of the suite has ever reached. `conformance/subjects/coverage.test.mjs` pins it as unreachable: no subject can plant it, and no implementation sets `consequenceHeldBefore`. A realm that snapshots a filesystem before it acts holds the before-state inherently, and a build run twice produces the scenario exactly.
- **`outcome-in-an-unwatched-place`** had no entry on any subject. `conformance/README.md` says so plainly: _"nobody has yet built a subject that can produce 'the result appears somewhere this implementation is not watching'."_ A tool writing outside its declared roots is that scenario in one line.

## The rule these obey

Every defect here is reachable by an argument and does nothing unless asked. Nothing is planted to match a detector we happen to have — the behaviours come from the suite, which drew them from failures this project shipped, and a tool whose only bug is one we already look for would demonstrate nothing.

```bash
node smoke.mjs --scenario healthy --out ./work
```
