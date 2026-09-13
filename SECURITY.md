# Security Policy

## Reporting a vulnerability

Please report security issues privately to **hey@reticle.sh** — do not open a public issue for an undisclosed vulnerability.

Include, where possible:

- the affected package(s) and version,
- a description and impact,
- steps to reproduce (a minimal repro is ideal),
- any suggested remediation.

We aim to acknowledge reports within **2 business days** and to keep you updated as we investigate and fix. We'll credit reporters who wish to be named once a fix has shipped.

## Scope

Reticle is **dev/preview-only** and **localhost-only** by design, and sends **nothing from the app under test** — no DOM, no request or response bodies, no source. It does send anonymous usage counters (which commands ran, which tools an agent called, whether a verdict was produced), and `npx @reticlehq/server telemetry disable` turns them off permanently. [`docs/telemetry.md`](docs/telemetry.md) is the complete list; [`docs/enterprise.md`](docs/enterprise.md) covers the rest of the data-handling posture. The most valuable reports concern anything that breaks those properties, for example:

- the browser SDK reaching a production bundle,
- the server binding beyond `127.0.0.1` or bypassing the verify-endpoint token,
- a `prod-preview` artifact leaking source coordinates, raw bodies, or app-state values,
- path traversal in the on-disk stores (`.reticle/flows`, `.reticle/runs`, baselines, visual).

## Supported versions

Security fixes target the latest released minor version on the default branch.
