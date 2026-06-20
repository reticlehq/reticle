# Iris — security & data handling

> The one-pager a security/architecture reviewer needs before embedding Iris. Iris is built so the
> honest answer to "where does our data go?" is **nowhere — it runs on your machine and in your infra.**

## What Iris is

A dev-only SDK embedded in your app + a local server (the bridge + MCP + verify endpoint) that lets an AI
agent or your pipeline observe and verify a running web app, returning a structured verdict.

## Data handling — the short version

| Question                                | Answer                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Does the SDK ship to production?        | **No.** It is dev/preview-only and tree-shaken out of production builds.                                 |
| Where does the server run?              | **Localhost.** The bridge binds `127.0.0.1`; the verify endpoint is localhost-bound + token-guarded.     |
| Does anything phone home?               | **No telemetry.** Iris sends nothing to Syrin or any third party.                                        |
| Where do artifacts live?                | On your disk: `.iris/runs/<id>.json`, `.iris/flows/`, `.iris/contract.json`. You own them.               |
| What can the server read?               | The DOM, network, console, routing, animations, and framework state of the app under test — locally.     |
| Can it leak source/app data downstream? | The **`prod-preview` profile** redacts source `file:line`, app-state values, and drops fix instructions. |

## Trust boundary

```text
[ your app + Iris SDK ]  ⇄ ws://127.0.0.1  ⇄  [ Iris server (your machine) ]  ⇄ MCP/HTTP  ⇄ [ your agent / pipeline ]
```

Everything is inside your trust boundary. There is no Iris cloud in the loop.

## Verify it yourself

- **Open source.** The SDK + server are source-available; read the tree-shaking and the `127.0.0.1` bind.
- **License model.** Per-package: Apache-2.0 on everything embedded (safe to ship in customer apps), FSL on
  the server, a source-available enterprise license for `ee/`. See the repo `LICENSE`.
- **Dependencies.** Standard ecosystem packages; an SBOM is available on request.

## Auth & access

- The verify endpoint supports a shared token (`x-iris-token`), compared in constant time. Localhost binding
  is the primary control; the token is defence in depth.
- Enterprise features (SSO/SAML, RBAC, SCIM, audit logs) live behind the `ee/` license and are the
  org-level controls layered on top — not required for a pilot.

## Compliance posture

- SOC 2 is **not** required for a design-partner pilot (no Iris-hosted data exists to certify). For
  enterprise GA, the roadmap adds the hosted control plane and its compliance program.
- For data-residency questions: the answer is "it stays in your environment."

Security contact / disclosure: **hey@syrin.ai** (see `SECURITY.md`).
