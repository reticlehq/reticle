# Reticle for enterprises

> Premium access (how you get + activate it), what's gated, the security/data-handling posture, and the licensing model. Integration mechanics live in [`integration.md`](./integration.md).

## How premium access works (offline, no phone-home)

Enterprise (`ee/`) features ship **inside the open package** — they're source-available (free for development, testing, and evaluation). A **license key activates them in production**. Activation is verified locally with Ed25519; nothing about your usage ever leaves your machine.

**The flow, end to end:**

1. **Buy** — contact **[hey@reticle.sh](mailto:hey@reticle.sh)**; we issue you a signed license key (org, plan, expiry, feature set).
2. **Install** — set it on the machine running the Reticle server:
   ```bash
   export RETICLE_LICENSE_KEY="<your key>"
   # the release already bakes the issuer public key (RETICLE_LICENSE_PUBLIC_KEY)
   ```
3. **Verify** — `reticle license` shows your status:
   ```
   active    licensed to Acme Corp (enterprise), expires 2027-06-20 · features: sso, audit
   eval      evaluation mode — enterprise features run free (no issuer key configured)
   missing   set RETICLE_LICENSE_KEY to activate enterprise features in production
   expired   renew to keep using enterprise features
   ```
4. **Unlock** — enterprise features now run in production; without a valid key they refuse to run there (a clear error, never a silent half-feature). In eval/dev they always run free.
5. **Renew** — keys carry an expiry; `reticle license` warns before it lapses.

> Procuring a license: contact **[hey@reticle.sh](mailto:hey@reticle.sh)**. Keys are issued offline and signed with Ed25519; the activation you run (`reticle license`) verifies them locally with no network call.

## What's gated (and the roadmap)

The licensing **mechanism** is open core (inspectable, FSL) — only the **features** under `ee/` are gated:

- **Today:** the activation gate + an example gated feature (audit event recording).
- **Roadmap** (the reliably enterprise-only set): **SSO/SAML, SCIM, RBAC / team permissions, audit logs, multi-org management, verify-before-merge policy gates, and the hosted control-plane connectors.** These are the things a security/compliance org pays for; the core verification engine stays free forever.

> What's premium vs free, and pricing, are business decisions for the owner — this doc describes the _mechanism_, not the price list.

## Security & data handling

The honest one-pager a security review needs. Reticle is built so the answer to "where does our data go?" is **nowhere — it runs on your machine, in your infra.**

| Question | Answer |
| --- | --- |
| Does the SDK ship to production? | **No** — dev/preview-only, tree-shaken from production builds. |
| Where does the server run? | **Localhost** — the bridge binds `127.0.0.1`; the verify endpoint is localhost-bound + token-guarded (constant-time), with request/body-size/timeout limits. |
| Does anything phone home? | **No telemetry.** Nothing is sent to Reticle — including license checks (offline Ed25519). |
| Where do artifacts live? | Your disk: `.reticle/runs/<id>.json` (atomic writes, bounded retention), `.reticle/flows/`, `.reticle/contract.json`. You own them. |
| What can the server read? | The DOM/network/console/routing/state of the app under test — locally. |
| Leak risk downstream? | The **`prod-preview` profile** redacts source `file:line`, raw bodies, and app-state values. |
| Path safety | Run/flow ids are validated as single path segments on read **and** write (no traversal). |

**Verify it yourself:** the SDK + server are source-available — read the tree-shaking, the `127.0.0.1` bind, and the offline license verify. `SECURITY.md` has the disclosure process; an SBOM is available on request. SOC 2 is a GA-stage item (no Reticle-hosted data exists today to certify); the posture above is the honest current state.

## Licensing model (per package)

| Scope | License | Why |
| --- | --- | --- |
| Embeddable SDK (`browser`, `protocol`, `react`, `babel-plugin`, `next`, `vite-plugin`, `eslint-plugin`) | **Apache-2.0** | safe to ship inside your customers' apps; explicit patent grant |
| Server / CLI / MCP (`server`, `test`, umbrella) | **FSL-1.1-ALv2** | free for any use except reselling Reticle itself; converts to Apache after 2 years |
| Enterprise features (`packages/server/src/ee/`) | **Reticle Enterprise License** | source-available; free for dev/eval, license key required in production |

Embedding / OEM / enterprise: **[hey@reticle.sh](mailto:hey@reticle.sh)**.
