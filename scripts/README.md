# What each script here is for

Sixteen files, and none of them is dead. This page says what each one does, who runs it, and when, so nobody has to open a script to find out whether it still matters.

They are grouped by **who runs them**, because that is the question people actually have. A script you never type is a very different thing from one you type during a release.

`packages/server/src/loose-scripts.test.ts` fails if a script here is reachable from nothing, and `scripts-documented.test.ts` fails if one is missing from this page. So both "quietly dead" and "quietly undocumented" are caught rather than noticed years later.

## Nobody runs these — they run themselves

Wired into `package.json` or a package's build, and they happen whether or not you think about them.

| script | what it does |
| --- | --- |
| `prepare-dist.mjs` | Before a package is packed, drops its tests and source maps out of `dist`. Used by nine packages. |
| `pack-docs.mjs` | Copies the docs and the skill file into `@reticlehq/server` before it is packed, so they ship with it. |
| `stamp-issuer-key.mjs` | Puts the public half of the enterprise licence key into the built server. Runs during that package's build, and the order matters: `prepack` wipes `dist` first, so anything that edits `dist` earlier is erased. |
| `assemble-changelog.mjs` | Folds the entry files in `.changes/` into the unreleased section of `CHANGELOG.md` at release time. |

## Checks — they run in CI and fail the build

Guards. Each one exists because something went wrong once and nobody noticed until much later.

| script | what it catches |
| --- | --- |
| `check-boundaries.mjs` | A package importing across the browser/server line, or an untagged package sneaking in as "safe for everyone". Run `--self-test` to prove the checker itself still catches a bad graph. |
| `check-lossy-transforms.mjs` | A read path that quietly drops part of what it was given. |
| `orphan-scan.mjs` | Modules nothing imports. Every package's `orphan-modules.test.ts` calls this one scanner rather than each writing its own. `orphan-scan.d.mts` beside it is just its type declaration; it has no other reason to exist. |
| `check-stale-issues.mjs` | An issue we already fixed still reading as available work, so somebody starts on it. |
| `check-docs-site.mjs` | Runs after the docs site deploys and fetches every page it claims to publish, so a page that 404s is caught by us rather than by a reader. |
| `guard-tests.mjs` | Works out which of a package's tests read the rest of the repository. Those cannot be cached like ordinary tests, because the thing they check lives outside the package. |
| `ci-run.mjs` | Wraps a CI command so "this failed" and "the runner never started" are told apart. A build that never ran is not a build that passed. |

## You run these, by hand

Rarely, and deliberately.

| script | when |
| --- | --- |
| `set-version.mjs` | During a release. Sets one version across every file that carries one. `RELEASING.md` is the procedure. |
| `local-registry.sh` | Publishes the packages to a registry on your own machine, so you can install them into a real outside app without publishing to npm. `verdaccio.yaml` beside it is that registry's config. The install gate uses both. See [local-registry.md](../docs/local-registry.md). |
| `issue-license.mjs` | Mints an enterprise licence key. Only useful if you hold the issuing key. |

## Adding a script

Add a row above, in the group that matches who will run it. `scripts-documented.test.ts` fails until you do — not to be strict, but because sixteen undocumented scripts is how somebody ends up asking whether any of them are still needed, which is the question this page exists to answer.
