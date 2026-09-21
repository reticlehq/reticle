# What each script here is for

Every file here is reachable from something that runs, and none of them is dead. This page says what each one does, who runs it, and when, so nobody has to open a script to find out whether it still matters.

They are grouped by **who runs them**, because that is the question people actually have. A script you never type is a very different thing from one you type during a release.

`server/src/loose-scripts.test.ts` fails if a script here is reachable from nothing, and `scripts-documented.test.ts` fails if one is missing from this page. So both "quietly dead" and "quietly undocumented" are caught rather than noticed years later.

## Nobody runs these — they run themselves

Wired into `package.json` or a package's build, and they happen whether or not you think about them.

| script | what it does |
| --- | --- |
| `prepare-dist.mjs` | Before a package is packed, drops its tests and source maps out of `dist`. Used by nine packages. |
| `test-suffixes.mjs` | The one definition of what a test file is. `prepare-dist.mjs`, `orphan-scan.mjs` and `directory-reach.mjs` all read it; they each had their own rule, and the file the three disagreed about shipped to npm. |
| `alias-dist.mjs` | After `tsc -b`, rewrites `@/…` back to relative paths for this package AND every package it references — `tsc -b` builds the whole reference graph, `tsc-alias` rewrites one of them. |
| `pack-docs.mjs` | Copies the docs and the skill file into `@reticlehq/server` before it is packed, so they ship with it. |
| `stamp-issuer-key.mjs` | Puts the public half of the enterprise licence key into the built server. Runs during that package's build, and the order matters: `prepack` wipes `dist` first, so anything that edits `dist` earlier is erased. |
| `assemble-changelog.mjs` | Folds the entry files in `.changes/` into the unreleased section of `CHANGELOG.md` at release time. |
| `remap-stranded-prs.mjs` | Replays a pull request written against the old `packages/*` layout onto the current tree, by rewriting the paths in its patch headers and never a content line. The destinations come from `v3-package-renames.tsv` (git's own rename record), because a package-root prefix lands most of those files on a path that does not exist. `pnpm remap:prs <pr>...` reports what would happen; `--apply` force-pushes. `node scripts/remap-stranded-prs.mjs --self-test` checks the lineage paths from #1033 without touching a pull request. |

## Checks — they run in CI and fail the build

Guards. Each one exists because something went wrong once and nobody noticed until much later.

| script | what it catches |
| --- | --- |
| `check-boundaries.mjs` | A package importing across the browser/server line, or an untagged package sneaking in as "safe for everyone". It reads which packages exist from the pnpm workspace file, so a package that moves cannot fall out of its sight. Run `--self-test` to prove the checker itself still catches a bad graph. `check-boundaries.d.mts` beside it is just the type declaration for the one function other checks reuse; it has no other reason to exist. |
| `check-lossy-transforms.mjs` | A read path that quietly drops part of what it was given. |
| `directory-reach.mjs` | Computes which directory imports from which, inside one package. Not a check itself: it is the graph that `server/src/directory-reach.test.ts`, the browser's copy of that guard, and `safe-to-group.mjs` all read. One implementation on purpose, because a prediction that disagrees with the test it predicts is worse than no prediction. `directory-reach.d.mts` beside it is the type declaration the guards import. |
| `orphan-scan.mjs` | Modules nothing imports. Every package's `orphan-modules.test.ts` calls this one scanner rather than each writing its own. `orphan-scan.d.mts` beside it is just its type declaration; it has no other reason to exist. |
| `check-stale-issues.mjs` | An issue we already fixed still reading as available work, so somebody starts on it. |
| `check-pending-release.mjs` | A release about to ship while an open issue still wears `fixed-pending-release`. The label means the fix is already on the release branch. `pnpm check:pending-release` runs it; the publish workflow runs it before npm. `--self-test` proves it still fails when the label is outstanding. |
| `check-docs-site.mjs` | Runs after the docs site deploys and fetches every page it claims to publish, so a page that 404s is caught by us rather than by a reader. |
| `guard-tests.mjs` | Works out which of a package's tests read the rest of the repository. Those cannot be cached like ordinary tests, because the thing they check lives outside the package. `guard-tests.d.mts` beside it is just the type declaration for the two functions other checks reuse; it has no other reason to exist. |
| `ci-run.mjs` | Wraps a CI command so "this failed" and "the runner never started" are told apart. A build that never ran is not a build that passed. |

## You run these, by hand

Rarely, and deliberately.

| script | when |
| --- | --- |
| `set-version.mjs` | During a release. Sets one version across every file that carries one. `RELEASING.md` is the procedure. |
| `local-registry.sh` | Publishes the packages to a registry on your own machine, so you can install them into a real outside app without publishing to npm. `verdaccio.yaml` beside it is that registry's config. The install gate uses both. See [local-registry.md](../docs/local-registry.md). |
| `issue-license.mjs` | Mints an enterprise licence key. Only useful if you hold the issuing key. |
| `safe-to-group.mjs` | Before moving files into a new subdirectory, asks whether it would make coupling worse. A group is unsafe exactly when some directory it reaches out to also reaches back into it — a mutual pair, and the only way a grouping can raise the count `directory-reach.test.ts` tracks. Written after three of the first four attempted groups had to be reverted; that test is still the authority, this just stops you learning its answer the slow way. See [gates.md](../docs/gates.md#reorganising-a-directory). |

## Adding a script

Add a row above, in the group that matches who will run it. `scripts-documented.test.ts` fails until you do — not to be strict, but because a directory of undocumented scripts is how somebody ends up asking whether any of them are still needed, which is the question this page exists to answer.
