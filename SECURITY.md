# Security Policy

## Reporting a vulnerability

Please report security issues privately to **hey@reticle.sh** — do not open a public issue for an undisclosed vulnerability.

Include, where possible:

- the affected package(s) and version,
- a description and impact,
- steps to reproduce (a minimal repro is ideal),
- any suggested remediation.

We aim to acknowledge reports within **2 business days** and to keep you updated as we investigate and fix. We'll credit reporters who wish to be named once a fix has shipped.

## Built to be safe to install

- **Dev-only SDK.** Dead-code eliminated from production builds (the Vite plugin applies only to `serve`), with a runtime guard that refuses to connect when the build reports `NODE_ENV=production`.
- **Localhost-only bridge.** The daemon binds `127.0.0.1`, and an app pairs with it using a token stored owner-only at `~/.reticle/pairing-token`. The HTTP verify endpoint is token-guarded.
- **No arbitrary code.** The in-page SDK runs a fixed set of commands (look, act, read state, navigate). No tool evaluates JavaScript supplied by an agent.
- **Credentials redacted at the source.** Credential-shaped values in captured request and response bodies, storage and state are replaced with `[REDACTED]` before they reach the agent.
- **Your app's data stays on your machine.** Nothing from the app under test (DOM, request or response bodies, console output, state, source) is sent. Syncing runs or flows happens only after an explicit `reticle login` and `reticle link`.
- **Anonymous usage counts are sent by default:** which commands ran, which tools an agent called, whether a verdict was produced. `npx @reticlehq/server telemetry disable`, `RETICLE_TELEMETRY=0` or `DO_NOT_TRACK=1` turns them off. [`docs/telemetry.md`](docs/telemetry.md) is the complete list; [`docs/enterprise.md`](docs/enterprise.md) covers the rest of the data-handling posture.
- **The installer's changes are scoped.** It registers the MCP server with the coding agents it finds and pre-approves only Reticle's own tools where an agent has a per-server approval rule. It writes nothing outside agent configs and `~/.reticle`, and the manual install does each step by hand.

## Scope

The most valuable reports concern anything that breaks the properties above, for example:

- the browser SDK reaching a production bundle,
- the server binding beyond `127.0.0.1` or bypassing the verify-endpoint token,
- a `prod-preview` artifact leaking source coordinates, raw bodies, or app-state values,
- path traversal in the on-disk stores (`.reticle/flows`, `.reticle/runs`, baselines, visual).

## Supported versions

Security fixes target the latest released minor version on the default branch.
