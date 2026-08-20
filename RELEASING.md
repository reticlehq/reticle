# Releasing

How versions are decided, cut, and announced. If you're contributing, the only part you need is [Changelog entries](#changelog-entries).

## Versioning

Every published `@reticlehq/*` package shares **one version, bumped in lockstep** — `core`, `browser`, and `server` speak the same wire contract, so a user pairing `browser@2.2.1` with `server@2.3.0` is a support question we don't want. One number means "these were tested together".

[SemVer](https://semver.org), where the public surface is: the MCP tool names and their input/output shapes, the wire contract in `@reticlehq/core`, the exported API of each package, the `reticle` CLI flags, and the on-disk flow/journal format.

- **patch** — bug fix, a new false-green class caught, docs, perf.
- **minor** — a new tool, a new predicate kind, a new adapter, a new CLI flag. Additive: existing calls behave identically.
- **major** — a tool renamed or removed, an output field removed, a wire message changed incompatibly, a saved flow that no longer replays. Ships with a [MIGRATION.md](MIGRATION.md) entry.

A deprecation gets one minor release of warning before removal in the next major.

## Cadence

- **Minor — roughly monthly**, when there's something worth shipping. Cut on a Tuesday, never on a Friday.
- **Patch — whenever a fix is ready.** No batching; a fix sitting in `main` helps nobody.
- **Major — rarely, announced ahead.** The tracking issue goes up at least two weeks before the tag, so users can object while it's still cheap.

The date is not the commitment; the shipped-and-green build is. A quiet month means a quiet month.

## Changelog entries

Any user-facing change adds its entry to the `[Unreleased]` section of [CHANGELOG.md](CHANGELOG.md) **in the same PR** — that's what makes cutting a release a 10-minute job instead of an archaeology session. Write it for someone who hits the bug, not for someone reading the diff: what was wrong, what it cost them, what it does now.

## Cutting a release

```bash
git switch main && git pull                     # 1. green main, nothing local

pnpm format:check                               # 2. the gates. FIRST: it is the one CI enforces
pnpm lint && pnpm typecheck && pnpm test:unit   #    that `pnpm lint` does not run
pnpm test:e2e                                   #    required for every release, not just tool changes
pnpm lint:docs                                  #    every documented command still parses; see below
claude plugin validate .                        #    the published Claude Code plugin still resolves
npx skills add reticlehq/reticle -l             #    the published skills are all still discoverable

pnpm version 2.3.0 --no-git-tag-version         # 3. bump root…
pnpm -r exec npm version 2.3.0 --no-git-tag-version   #    …and every workspace package, in lockstep
```

### What the gates already prove about the docs, and what they do not

`pnpm test:unit` carries the shipped-guidance guards, so a release cannot go out with docs that contradict the code. They cover **README.md, SKILL.md, every page under `docs/`, every published skill, and every package README**:

| Guard | What it would catch |
| --- | --- |
| every declared tool name is callable | a renamed `reticle_*` tool leaving dead prose |
| documented commands are run through the real CLI parser | a retired subcommand, or a flag that no longer exists |
| nobody is told to `npx` a package we do not own | `npx reticle`, which fetches somebody else's package |
| no runnable shell block assumes the `reticle` bin | a command that fails for a reader who installed nothing |
| every published skill has valid frontmatter and a matching name | a skill the registry silently refuses to install |
| the plugin version matches the release | a `/plugin` UI pinning everybody to a stale version |
| docs index and navigation cover every page | a page nobody can reach |

Two limits worth knowing before trusting a green run.

**Flag validation is per-command.** `init` and `serve` reject an unknown flag; `doctor`, `status`, `gate` and `open` accept one silently, so a documented flag that quietly stopped existing on those commands still passes. Making the parser uniform would close it, and would be a behaviour change to argument handling rather than a docs fix.

**None of it checks the deployed site.** The guards read this repository. `docs.reticle.sh` is a separate Mintlify deployment, and it has served pages several commits behind before, so a page being correct here is not evidence that it is correct in front of a user. Check the live page after a release, not only the source.

4. Move `[Unreleased]` in `CHANGELOG.md` under a `## [2.3.0] — YYYY-MM-DD` heading; leave a fresh empty `[Unreleased]`.

   **First, check what landed behind it:**

   ```bash
   git log --oneline "$(git log -1 --format=%H -- CHANGELOG.md)"..HEAD
   ```

   A release section is written once and then commits keep arriving, so the entry you are about to publish describes the release as it was on the day somebody opened the section. That has now happened twice in one release: the first time thirty-three commits had landed behind it including both headline fixes, the second time eighteen more. Both were found by running exactly the command above, and nothing else would have found either.

   Not every commit earns an entry — a retuned test budget or a new internal guard changes nothing a user can observe. The question to ask of each is whether somebody deciding whether to upgrade would want to know.

5. `git commit -m "chore(release): v2.3.0"` → PR → merge.
6. `git tag v2.3.0 && git push --tags`
7. **Publish a GitHub Release** on that tag, body = the changelog section. This is what triggers publishing — [`.github/workflows/publish.yml`](.github/workflows/publish.yml) runs the gates again and `pnpm -r publish`es in dependency order with npm provenance. It skips versions already on npm, so a partial run is safe to re-trigger.
8. `npm view @reticlehq/server version` to confirm, then post the release in Discord `#announcements` with the one-line "why you'd care".

If a release goes out broken: publish a patch. Never `npm unpublish` — installs in the wild break.

## Pre-releases

Risky or contract-touching work ships as `2.3.0-rc.1` on the `next` dist-tag first, announced in Discord for anyone willing to try it. Same process, `--tag next` on the publish.
