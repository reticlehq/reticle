# Security Policy

## Reporting a vulnerability

Please report security issues privately to **hey@reticle.ai** — do not open a public issue for an undisclosed vulnerability.

Include, where possible:

- the affected package(s) and version,
- a description and impact,
- steps to reproduce (a minimal repro is ideal),
- any suggested remediation.

We aim to acknowledge reports within **2 business days** and to keep you updated as we investigate and fix. We'll credit reporters who wish to be named once a fix has shipped.

## Scope

Reticle is **dev/preview-only** and **localhost-only** by design, and sends **no telemetry** — see [`docs/enterprise.md`](docs/enterprise.md) for the full data-handling posture. The most valuable reports concern anything that breaks those properties, for example:

- the browser SDK reaching a production bundle,
- the server binding beyond `127.0.0.1` or bypassing the verify-endpoint token,
- a `prod-preview` artifact leaking source coordinates, raw bodies, or app-state values,
- path traversal in the on-disk stores (`.reticle/flows`, `.reticle/runs`, baselines, visual).

## Supported versions

Security fixes target the latest released minor version on the default branch.
