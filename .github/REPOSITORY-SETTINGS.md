# Repository settings for an A+ OpenSSF Scorecard

The workflows in this directory (CI, CodeQL, Scorecard, publish) cover everything code can. A few Scorecard checks are **repository settings** that only a maintainer with admin can toggle in the GitHub UI or via `gh`. This file is the exact checklist — do these once and the security posture is A+.

## 1. Branch protection on `main` (Scorecard: Branch-Protection, Code-Review — High weight)

Settings → Branches → Add rule for `main`:

- [ ] **Require a pull request before merging** — with **at least 1 approving review**.
- [ ] **Dismiss stale approvals** when new commits are pushed.
- [ ] **Require status checks to pass** — select: `verify` (CI), `e2e`, `analyze` (CodeQL). Require branches be **up to date** before merging.
- [ ] **Require conversation resolution** before merging.
- [ ] **Do not allow force pushes**; **do not allow deletions**.
- [ ] Apply the rule to **administrators too** (Scorecard rewards `EnforceAdmins`).

Via CLI (adjust the check names to match the run titles):

```bash
gh api -X PUT repos/reticlehq/reticle/branches/main/protection \
  -f "required_status_checks[strict]=true" \
  -f "required_status_checks[checks][][context]=verify" \
  -f "required_status_checks[checks][][context]=analyze" \
  -F "enforce_admins=true" \
  -F "required_pull_request_reviews[required_approving_review_count]=1" \
  -F "required_pull_request_reviews[dismiss_stale_reviews]=true" \
  -F "restrictions=null"
```

> Solo-maintainer note: requiring a review of your own PRs is friction, but Scorecard's Code-Review check reads merge history — a self-merge with no review caps the score. Options that still earn it: enable the rule and use a second account / a co-maintainer for approvals, or accept the cap as the one honest ceiling of a solo project and note it in the README (the community reads a solo project's Scorecard with that context).

## 2. Signed tags / releases (Scorecard: Signed-Releases)

npm **provenance** is already on (`publish.yml`). For the git side:

- [ ] Sign release tags: `git config tag.gpgSign true` (GPG) **or** adopt Sigstore `gitsign` for keyless signing. Sign at least every `vX.Y.Z` release tag.
- [ ] Settings → General → enable **"Require signed commits"** on `main` once contributors are set up to sign (don't enable before, or you'll block yourself).

## 3. Security features (Scorecard: SAST, Vulnerabilities, Dependency-Update-Tool)

Settings → Code security and analysis:

- [ ] **Dependabot alerts** + **Dependabot security updates** = ON (the `dependabot.yml` here handles version updates; these two are the alert side).
- [ ] **Code scanning** = ON (the `codeql.yml` here provides it; confirm it's enabled).
- [ ] **Secret scanning** + **push protection** = ON.
- [ ] **Private vulnerability reporting** = ON (Settings → Security) — pairs with `SECURITY.md`.

## 4. Token defaults

- [ ] Settings → Actions → General → **Workflow permissions** = **Read repository contents** (the per-workflow `permissions:` blocks already declare more where needed; the default should be read-only).

## 5. After enabling

- Let the Scorecard workflow run once (it's scheduled + on push to `main`), then add the badge: `[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/reticlehq/reticle/badge)](https://securityscorecards.dev/viewer/?uri=github.com/reticlehq/reticle)` (already added to the README; it goes live once the first run publishes).
