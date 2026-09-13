# `.changes/`

One file per changelog entry. `CHANGELOG.md` is assembled from them at release time.

## Why this exists

`CHANGELOG.md` was the single largest merge-conflict source in this repo: of 42 open PRs, **23 edited it and 11 were conflicting on it** — every one of those conflicts a `[Unreleased]` section that two branches appended to in the same place. The policy was right (the entry lands in the same PR as the change, so cutting a release is ten minutes and not archaeology); the mechanism was wrong. Two PRs adding two files never conflict. Two PRs editing one file always might.

## The format

Add `.changes/<anything>.md` — the name is yours, `<issue>-<slug>.md` is the convention. The file is a Keep-a-Changelog heading, a blank line, and the bullet:

```md
### Fixed

- **`@reticlehq/server` — `reticle_navigate` gave up at 5s and called it a failed navigation.** A Nuxt SPA reattaching under HMR takes 30–60s, so every navigation to it answered `confirmed: false` while the app was still coming back. `timeout_ms` now reaches the wait. Closes [#856](https://github.com/reticlehq/reticle/issues/856).
```

Rules, all of them enforced by `pnpm changelog:assemble` refusing the file:

- **The first non-blank line is a `### ` heading.** Use the Keep-a-Changelog six: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`. Anything else is passed through and lands in its own subsection, which is occasionally what you want and usually a typo.
- **Everything after it is the entry**, verbatim. Markdown, however many bullets and paragraphs it takes.
- Write it for someone who hit the bug, not for someone reading the diff: what was wrong, what it cost them, what it does now.

Not user-facing — a retuned test budget, a new internal guard, a refactor nobody can observe? No file. The question is whether somebody deciding whether to upgrade would want to know.

## Assembling

```bash
pnpm changelog:assemble --dry-run   # print the CHANGELOG.md that would be written
pnpm changelog:assemble             # splice into [Unreleased] and delete the consumed files
```

Entries merge into the existing `### ` subsections of `## [Unreleased]`; nothing already written there is moved or rewritten. This runs at release time, as step 4 of [RELEASING.md](../RELEASING.md) — not per-PR, because a PR that assembles is a PR that edits `CHANGELOG.md`, which is the thing this directory exists to stop.
