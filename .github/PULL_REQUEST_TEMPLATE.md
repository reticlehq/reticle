<!-- Thanks for contributing to Reticle! Please fill this out so review is fast. -->

## What & why

<!-- What does this change, and why? Link the issue it closes. -->

Closes #

## How it was verified

<!-- How do you know it works? Tests added, manual repro, benchmark run, etc. -->

## Gates run

<!-- Tick the fast gate, plus any tier your change needs. Full map: docs/gates.md.
     CI runs everything regardless — this just tells the reviewer what you already know is green. -->

- [ ] `pnpm lint && pnpm typecheck && pnpm test:unit` (~2 min — **always**)
- [ ] `pnpm test:e2e` (~8 min) — _touched the tool surface, `packages/core`, an observer, or telemetry_
- [ ] `pnpm gate:install` (~15 min) — _touched `reticle init`, `vite-plugin`, `next`, or `babel-plugin`_
- [ ] `pnpm test:e2e:desktop` (~3 min) — _touched `packages/electron`, `packages/tauri`, or desktop capture_
- [ ] None of the above tiers apply to this change

## Checklist

- [ ] **Every commit is signed off** (`git commit -s`) — CI's DCO check fails the PR without it. Already pushed? `git rebase --signoff origin/main && git push --force-with-lease`
- [ ] Tests added/updated (RED → GREEN); the change is covered by a test that would fail without it
- [ ] No `any`, no free strings (wire strings live in `@reticlehq/core`), no non-null `!`
- [ ] No `console.log` or internal tracking codes left in the diff
- [ ] Each changed file is under the 1000-line cap
- [ ] Docs and `CHANGELOG.md` updated if this is user-facing (entry under `[Unreleased]`)
- [ ] Security-affecting? Auth/redaction/trust-boundary changes keep the localhost-only, no-app-data-leaves-the-machine, no-arbitrary-JS posture (usage telemetry stays anonymous + opt-out per `docs/telemetry.md`) and are covered by a test
