# Iris Enterprise (`ee/`)

Everything under this directory is **Iris Enterprise** code, source-available under the
[Iris Enterprise License](./LICENSE) — **not** the FSL that covers the rest of `@syrin/iris-server`.

- **Free** for development, testing, and evaluation.
- **Production use requires a valid Iris Enterprise subscription license key.**

## Rules for code in this directory

- Enterprise-only features live here and **nowhere else**. The free server must never `import` from
  `ee/`; the dependency only ever points `ee/ → core`, never the reverse, so the OSS build is always
  complete on its own.
- Every enterprise feature entry point calls `assertEnterprise(feature)` (imported from the open-core
  gate at `../license/license.js`) before doing privileged work. The licensing _mechanism_ is open
  (FSL) so it's inspectable and the OSS build is complete; only the _features_ here are gated.
- The wire contract these features speak is still defined in `@syrin/iris-protocol` (Apache-2.0), so
  free and enterprise builds can never drift apart.

## What belongs here (post-v0.9.0)

SSO / SAML, SCIM, RBAC / team permissions, audit logs, multi-org management, policy enforcement /
verify-before-merge gates, and the hosted control-plane connectors. None of these ship in v0.9.0 — this
directory and its license boundary exist now so the line is set before the features arrive.
