# Governance

Reticle is young and maintainer-led. This document says how decisions get made and how that scales as more people contribute — so the process is legible rather than implicit.

## Roles

- **Maintainers** review and merge changes, cut releases, and own the roadmap. Today this is a small core team; the list of people with merge rights is the GitHub org's maintainer team.
- **Contributors** are anyone who opens an issue or a PR. You don't need to ask permission — open a PR.

## How decisions are made

- **Everyday changes** (bug fixes, docs, tests, additive features that don't change the wire contract) are decided in the PR: a maintainer review + green CI is enough to merge.
- **Contract-affecting changes** — anything that touches the wire protocol (`@reticlehq/core`), a tool's name or output shape, an on-disk flow/journal format, or a public API — need a maintainer's explicit sign-off and a note in the PR describing the compatibility impact, because they ripple across the SDK, the server, and users' saved flows. When in doubt, open an issue first to agree the shape.
- **Direction** (what ships next, licensing, breaking changes) is a maintainer decision, informed by issues and discussions. The [ROADMAP](./ROADMAP.md) reflects it; the [CHANGELOG](./CHANGELOG.md) records what actually shipped.

Disagreements are resolved by discussion in the issue/PR; if consensus isn't reached, the maintainers make the call and explain it. We optimise for keeping the verifier honest and the wire contract stable over shipping fast.

## Becoming a maintainer

There's no committee. Land a few substantial, well-tested PRs, review others' work thoughtfully, and a maintainer will invite you. Sustained, trustworthy contribution is the whole bar.

## Non-negotiables (why some PRs get pushback)

These are the rules a change is held to regardless of who sends it — they're in [CONTRIBUTING.md](./CONTRIBUTING.md) and enforced in CI:

- Tests-first, and the gates (lint, typecheck, unit, and the e2e battery for tool/wire/observer changes) must pass.
- The wire contract lives in `@reticlehq/core` — never inline a wire string in `browser`/`server`.
- The service boundaries hold: `browser` touches only the DOM, `server` only Node, `react` is optional enrichment core must work without.
- No false greens. A change that lets the verifier report success on evidence it doesn't have will be rejected — that's the one thing this project exists to prevent.

## Security & conduct

Security disclosures go to **hey@reticle.sh** (see [SECURITY.md](./SECURITY.md)); conduct concerns to the same address (see [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)).
