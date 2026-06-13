# SKILL.md — Project Foundation (applied)

This repo was scaffolded with the **Project Foundation** skill (top-1% engineering
standards). The skill's two halves were applied as follows:

- **Part I (setup)** → the monorepo scaffold, configs, git hook, and tooling in this repo.
- **Part II (engineering standards)** → distilled and adapted into the `skills/*.md` files,
  which are the permanent operating manual for all code here.

Adaptations made for Iris (a pure-TypeScript monorepo, not an app + Python backend):

- **One git repo** at the root (pnpm + turbo monorepo convention) instead of repo-per-service.
- **No Python** — `skills/python.md` is marked N/A; equivalents live in `skills/typescript.md`.
- **No database yet** — `skills/database.md` covers the planned local JSON baseline/recording
  store; full II.12 applies if a real DB is ever added.
- The DB-engineering, idempotency, and distributed-systems sections were mapped onto Iris's
  actual surfaces (the wire protocol, the bridge relay, the local baseline store).

The operating manual is `CLAUDE.md` + `skills/`. Read those, not this file, when writing code.
