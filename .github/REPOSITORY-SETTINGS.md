# OpenSSF Scorecard maintenance checklist

Use the [current Scorecard report](https://securityscorecards.dev/viewer/?uri=github.com/reticlehq/reticle) to prioritize failing checks. Workflow files show intent; successful runs, repository settings, release assets, and reviewed merge history show enforcement. This checklist does not guarantee a particular score.

## 1. Protect `main` (Branch-Protection and Code-Review)

Inspect existing branch protection and rulesets before changing them. Preserve existing restrictions and required checks.

```bash
gh api repos/reticlehq/reticle/branches/main/protection
gh api repos/reticlehq/reticle/rulesets
gh api repos/reticlehq/reticle/commits/main/check-runs --jq '.check_runs[].name'
```

Settings → Rules → Rulesets, or Settings → Branches:

- [ ] Require a pull request before merging.
- [ ] Require at least one approving review from another maintainer once an independent reviewer is available.
- [ ] Dismiss stale approvals when new commits are pushed; require code-owner review.
- [ ] Require status checks and up-to-date branches. Include `gate` (the CI aggregate), `package-quality`, and the exact CodeQL matrix check name reported by GitHub, currently expected to be `analyze (javascript-typescript)`. Preserve other required checks.
- [ ] Require conversation resolution.
- [ ] Block force pushes and branch deletion.
- [ ] Enforce protection for administrators and remove routine bypasses.
- [ ] If a merge queue is enabled, ensure every required workflow runs on `merge_group` before requiring it in the queue.

`verify` alone does not enforce unit tests, e2e, Rust, desktop, and the other jobs included in `gate`. Package quality and CodeQL run in separate workflows and must be required separately.

Code-Review examines recent merge history, so enabling a rule does not repair earlier unreviewed merges. This repo's CODEOWNERS currently names one maintainer. Recruit an independent co-maintainer for reviews; another account controlled by the author and bot approvals do not supply independent human review. Until a reviewer is available, retain the CI protections and accept the review-score limitation rather than blocking all maintainer PRs.

## 2. Verify release assets (Signed-Releases)

`publish.yml` requests npm provenance. `release-provenance.yml` fetches published npm tarballs and attaches those tarballs plus SLSA `.intoto.jsonl` provenance to the GitHub release. Confirm that both workflows succeed and that recent releases actually contain the assets.

```bash
gh run list --repo reticlehq/reticle --workflow release-provenance.yml --limit 5
gh release list --repo reticlehq/reticle --limit 5
# Repeat for each recent release tag:
gh release view v3.3.0 --repo reticlehq/reticle --json assets --jq '.assets[].name'
```

- [ ] Recent releases contain the published tarballs and corresponding `.intoto.jsonl` assets.
- [ ] Investigate missing assets or failed provenance runs before publishing another release.
- [ ] For an older release whose npm packages are still available, use the workflow's manual dispatch with that release tag and inspect the resulting assets. This attests the download of already-published tarballs; it does not retroactively prove their original build.

Signed tags and signed commits are useful separate controls. They do not substitute for the release-asset signatures or provenance that Signed-Releases detects.

## 3. Resolve dependency vulnerabilities and verify security features

- [ ] Enable Dependabot alerts and security updates. `dependabot.yml` handles version updates for npm, Actions, and Cargo.
- [ ] Confirm CodeQL runs successfully and uploads results; review unresolved findings.
- [ ] Enable secret scanning, push protection, and private vulnerability reporting.
- [ ] Scan committed dependency trees with OSV-Scanner and remediate findings. Scorecard's Vulnerabilities check uses OSV; a clean `pnpm audit` alone does not establish a clean Scorecard result.
- [ ] Keep the high/critical JavaScript audit and Rust audits passing in CI. High/critical JavaScript advisories now fail `verify`, which is included in `gate`.
- [ ] Where a vulnerability genuinely does not apply, document a narrowly scoped exception with evidence and review it when dependencies change.

### Reviewed JavaScript audit exceptions (2026-10-03)

`scripts/check-js-audit.mjs` keeps high/critical advisories fatal except for the exact lockfile paths below. It also checks that both direct dependencies stay in private development-tool manifests. Its self-test proves that a new advisory, unknown severity, changed path, available patch, stale exception, muted finding, or move into production dependencies fails CI. Remove an exception as soon as a patched release can be installed; dependency-path changes also require a new review.

- `GHSA-ch52-4w7c-c8xp`: `http-cache-semantics@4.2.0` is reached only through `apps/e2e`'s `verdaccio@6.10.4` test-registry dependency. The install gate now binds that ephemeral registry to `127.0.0.1`; it stores test packages and an ephemeral test user, not production sessions or cross-user cached responses. The advisory concerns max-stale exposure of another user's cached session response. There is no upstream patch yet, so this exact development path is excepted. If this package reaches a shipped runtime or another path, the guard fails.
- `GHSA-vfj7-8cjw-p6xm`: `braces@3.0.3` is reached only through the root build tool `tsc-alias > chokidar`. Reticle invokes `tsc-alias` to rewrite its own compiled output, without watch mode or untrusted brace patterns. The advisory concerns stack exhaustion from a deeply nested attacker-supplied pattern. There is no upstream patch yet, so this exact build path is excepted. If this package reaches another path, the guard fails.

## 4. Keep build tools pinned and tokens restricted

- [ ] Keep Actions pinned to commit SHAs and let Dependabot update them. The SLSA reusable generator retains its supported version-tag reference.
- [ ] Move `publint@0.3.21` and `@arethetypeswrong/cli@0.18.5` into root devDependencies and regenerate `pnpm-lock.yaml` with registry access. Then replace their versioned `npx` invocations with `pnpm exec publint` and `pnpm exec attw` while preserving each package's working directory. Exact tool versions are an interim improvement; their transitive dependencies are not yet locked.
- [ ] Use the existing lockfile-managed Verdaccio in `apps/e2e` for the local registry script.
- [ ] Set the Actions default token permissions to read-only. Declare necessary write permissions only at job level.

## 5. Best Practices badge and fuzz coverage

- [ ] Register the canonical repository URL at [OpenSSF Best Practices](https://www.bestpractices.dev/) and complete the passing criteria with accurate evidence. This is separate from the Scorecard badge in README.
- [ ] Keep `core/src/wire/redaction.fuzz.test.ts` running in the unit suite. It already uses `fast-check`, which current Scorecard versions recognize. If Fuzzing is low, check the analyzed commit and scanner version before adding another framework.

Contributor diversity and maintenance checks reflect real project participation and activity. Do not manufacture contributions or reviews to raise those scores.

## 6. Verify the result

- [ ] Merge the workflow changes through the required checks.
- [ ] Confirm the Scorecard workflow succeeds after the push to `main` or its weekly schedule.
- [ ] Compare the report's analyzed commit, date, and individual checks against the baseline. Public badge updates can lag the workflow.
- [ ] Record remaining limitations rather than promising a score before the scan completes.

Check definitions evolve: consult the [official Scorecard criteria](https://github.com/ossf/scorecard/blob/main/docs/checks.md) alongside the version reported by the actual scan.
