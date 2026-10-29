---
title: Enterprise
description: 'License keys and activation, the enterprise roadmap, the security and data-handling posture, and the licensing model.'
icon: building
---

Every Reticle package is Apache-2.0. An enterprise customer gets a signed license key, which you set as `RETICLE_LICENSE_KEY`. Activation is verified locally with Ed25519 and makes **no network call**. Usage metrics are separate: they are on by default, and on a licensed build they carry your licence id. Turn them off with `RETICLE_TELEMETRY=0`. See [telemetry](/telemetry). Run `npx @reticlehq/server license` to see whether you are `active`, `eval`, `missing`, `expired` or `invalid`.

> For how to connect a platform to Reticle, see [Platform integration](/platform-integration).

> **Already have a key and just need to switch it on?** [Activating a license key](./license-activation) is the step-by-step version: where to set it on each platform, the editor and CI cases, how to read every status, and what to do when it does not work.

## How a license key works (offline, no phone-home)

No feature in the open packages needs a key. A key identifies your organisation to Reticle. Activation is verified locally with Ed25519 and sends nothing. Usage metrics, which you can turn off, carry your licence id on a licensed build.

**The flow, end to end:**

1. **Buy.** Contact **[hey@reticle.sh](mailto:hey@reticle.sh)**; we issue you a signed license key (license id, org, plan, expiry). The **license id** is the stable handle on your subscription: it survives a rename, and it is what a renewal continues.
2. **Install.** Set it on the machine running the Reticle server:
   ```bash
   export RETICLE_LICENSE_KEY="<your key>"
   # the release already bakes the issuer public key (RETICLE_LICENSE_PUBLIC_KEY)
   ```
3. **Verify.** `reticle license` prints one JSON line whose `status` and `detail` say where you stand:

   ```
   active    licensed to Acme Corp (enterprise), expires 2027-06-20T00:00:00.000Z
   eval      evaluation mode (no issuer key configured)
   missing   set RETICLE_LICENSE_KEY to activate a license. Request a key from hey@reticle.sh
   expired   license expired. Renew with hey@reticle.sh
   invalid   license key rejected (<reason>). hey@reticle.sh can re-issue it
   ```

   Every status reports `contact`, so a reader who is stuck always has somebody to write to. A published release has the issuer key baked in. Only a build from source, with no issuer key, reports `eval`.

4. **Renew.** Keys carry an expiry, shown as `expiresAt`; once it passes, the status is `expired`.

> Procuring a license: contact **[hey@reticle.sh](mailto:hey@reticle.sh)**. Keys are issued offline and signed with Ed25519; the activation you run (`reticle license`) verifies them locally with no network call.

## Roadmap

**SSO/SAML, SCIM, RBAC / team permissions, audit logs, multi-org management, verify-before-merge policy gates, and the hosted control-plane connectors** are planned for the hosted Reticle platform, not for the open packages. The core verification engine stays free.

> For pricing, write to [hey@reticle.sh](mailto:hey@reticle.sh). This page describes the mechanism, not the price list.

## Security & data handling

The honest one-pager a security review needs. Reticle is built so the answer to "where does our data go?" is **nowhere, unless you link a project to the dashboard. It runs on your machine, in your infra.**

| Question | Answer |
| --- | --- |
| Does the SDK ship to production? | **Not by default.** The dev SDK is dev/preview-only and tree-shaken from production builds. If you opt in to [production mode](/production-mode), the `@reticlehq/browser/activate` loader ships. A visitor's page load reads one query parameter and loads no SDK, opens no socket and writes nothing. Only a signed, single-use ticket loads the SDK. |
| Where does the server run? | **Localhost.** The bridge binds `127.0.0.1`; the verify endpoint is localhost-bound + token-guarded (constant-time), with request/body-size/timeout limits. |
| Does anything phone home? | **No app data unless you opt in.** Linking a project to the dashboard (`reticle connect`) sends its runs there; see [what is recorded](/what-is-recorded) and `reticle config` for what it sends. License checks are offline (Ed25519). The CLI sends opt-out usage metrics only (random id + event names, no code, no PII; on a licensed build they carry your licence id; see [telemetry](/telemetry)); disable fleet-wide with `RETICLE_TELEMETRY=0` or per-machine with `reticle telemetry disable`. Feedback your team explicitly sends us (`reticle feedback`) is the only free text that ever leaves; it is never collected passively, is redacted client-side, and is disabled fleet-wide with `RETICLE_FEEDBACK=0`. |
| Where do artifacts live? | Your disk: `.reticle/runs/<id>.json` (atomic writes, bounded retention), `.reticle/flows/`, `.reticle/contract.json`. You own them. |
| What can the server read? | The DOM/network/console/routing/state of the app under test, locally. |
| Leak risk downstream? | The **`prod-preview` profile** redacts source `file:line`, raw bodies, and app-state values. |
| Path safety | Run/flow ids are validated as single path segments on read **and** write (no traversal). |

**Verify it yourself:** the SDK and server are open source, so read the tree-shaking, the `127.0.0.1` bind, and the offline license verify. `SECURITY.md` has the disclosure process; an SBOM is available on request. SOC 2 is not in place; the posture above is the honest current state.

## Licensing model

| Scope | License | Why |
| --- | --- | --- |
| The protocol and the rules (`open-verification`, `core`, `engine`) | **Apache-2.0** | the part that DECIDES a verdict, auditable and reimplementable by anyone |
| Embeddable SDK (`browser`, `react`, `babel-plugin`, `next`, `vite-plugin`, `electron`, `eslint-plugin`) | **Apache-2.0** | safe to ship inside your customers' apps; explicit patent grant |
| Server / CLI / MCP (`server`, `init`, `test`) | **Apache-2.0** | use, change and redistribute it anywhere |

Embedding / OEM / enterprise: **[hey@reticle.sh](mailto:hey@reticle.sh)**.
