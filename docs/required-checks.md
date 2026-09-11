---
title: Which checks can block a merge
description: A workflow that runs on every pull request does not necessarily stop anything being merged. Here is which ones do.
---

A workflow running on every pull request does not, on its own, stop anything being merged. GitHub only blocks a merge on checks the repository's **branch protection** setting names as required. That setting lives in the GitHub interface, not in this repository.

That gap is the difference between a gate and a decoration. A decoration still costs the same machine time on every pull request.

## How it works here

`ci.yml` ends in a single job called **`gate`**. It waits on every other job in that file and passes only when each one either succeeded or was legitimately skipped. So one required check, `gate`, covers all fifteen jobs in `ci.yml`.

That trick only reaches so far. A job can only wait on jobs in **its own workflow file**, so the five workflows below cannot be folded into `gate`. Each has to be named in branch protection separately, or it blocks nothing.

`server/src/ci-aggregate-covers-jobs.test.ts` fails if a new workflow starts running on pull requests without being accounted for, and if a job in `ci.yml` is not watched by `gate`.

## The list to require

Set these as required status checks on the default branch:

| check | what it is | what merges without it |
| --- | --- | --- |
| `gate` | every job in `ci.yml`: build, tests, e2e, desktop, install, Rust, Windows, macOS, bench | a red build of any kind |
| `package-quality` | the published packages: exports and types correctness, and the browser SDK's size budget | a package that installs but cannot be imported, or a silently growing SDK |
| `setup-gates` | onboarding | a broken first-run experience |
| `codeql` | security scan | a flagged vulnerability |
| `dco` | contributions are signed off | an unsigned contribution |

`labeler` is deliberately absent. It adds labels to a pull request; there is no result to block on.

## Adding a workflow

Two choices, and picking one is required rather than optional:

1. **Put its jobs in `ci.yml`.** `gate` then covers them and there is nothing to configure. Prefer this.
2. **Keep it separate.** Reasonable when it needs different permissions or a different trigger. Then add it to `PR_JOBS_OUTSIDE_THE_AGGREGATE` in the test above, and add it to the table here and to branch protection. All three, or it runs on every pull request and decides nothing.
