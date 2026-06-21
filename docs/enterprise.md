# Iris for enterprises

> Premium access (how you get + activate it), what's gated, the security/data-handling posture, and the
> licensing model. Integration mechanics live in [`integration.md`](./integration.md).

## How premium access works (offline, no phone-home)

Enterprise (`ee/`) features ship **inside the open package** — they're source-available (free for
development, testing, and evaluation). A **license key activates them in production**. Activation is
verified locally with Ed25519; nothing about your usage ever leaves your machine.

**The flow, end to end:**

1. **Buy** — contact **hey@syrin.ai**; we issue you a signed license key (org, plan, expiry, feature set).
2. **Install** — set it on the machine running the Iris server:
   ```bash
   export IRIS_LICENSE_KEY="<your key>"
   # the release already bakes the issuer public key (IRIS_LICENSE_PUBLIC_KEY)
   ```
3. **Verify** — `iris license` shows your status:
   ```
   active    licensed to Acme Corp (enterprise), expires 2027-06-20 · features: sso, audit
   eval      evaluation mode — enterprise features run free (no issuer key configured)
   missing   set IRIS_LICENSE_KEY to activate enterprise features in production
   expired   renew to keep using enterprise features
   ```
4. **Unlock** — enterprise features now run in production; without a valid key they refuse to run there
   (a clear error, never a silent half-feature). In eval/dev they always run free.
5. **Renew** — keys carry an expiry; `iris license` warns before it lapses.

> Issuer side (Syrin only): `scripts/issue-license.mjs keygen` (one-time keypair; bake the public key into
> the release, vault the private key) and `… sign --org … --plan … --days … [--features …]` to mint a
> customer key. The private key never ships.

## Issuer runbook (Syrin only)

How license keys actually get minted. The signing logic never changes as you scale — only **what** goes
in the payload and **when** you call it.

### One-time: create the signing keypair

```bash
node scripts/issue-license.mjs keygen
```

This prints two PEMs from a single Ed25519 keypair:

- **Public key** → bake into each release as `IRIS_LICENSE_PUBLIC_KEY` (env at build/deploy time). Safe to
  embed anywhere — it can only _verify_ keys, never mint them.
- **Private key** → the crown jewel. **One key signs every customer** (the payload's `org` identifies who);
  you never make a key per customer.

**Private-key rules (non-negotiable):**

- Never commit it — `.gitignore` already blocks `*.pem` / `*.key`. Never ship it in any package or release.
- Store it in a real secret manager (1Password / cloud KMS / Secrets Manager), not a long-lived plaintext
  file on a laptop.
- Load it only at sign time, via `IRIS_LICENSE_PRIVATE_KEY`, so it lives in process memory for seconds.
- Anyone holding it can mint unlimited free licenses — its leak is the one event that breaks the model.

### Per customer: mint a key

```bash
IRIS_LICENSE_PRIVATE_KEY="$(op read 'op://Vault/iris-issuer/private.pem')" \
  node scripts/issue-license.mjs sign --org "Acme Corp" --plan enterprise --days 365 --features sso,audit
# → prints the customer's IRIS_LICENSE_KEY (base64url(payload).base64url(signature))
```

Send the printed key to the customer; they set it as `IRIS_LICENSE_KEY` and run `iris license` to confirm
`active`. The payload carries `{ org, plan, exp, features }` — `exp` is `now + days`, so the key self-expires.

### How issuance scales (build the next step only when the current one hurts)

| Customers | How keys get issued                                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------- |
| 1–10      | Manual `sign` on your machine, key pasted into the contract/email. **Where you are now.**             |
| 10–50     | Same script behind a tiny internal admin page or a `make issue ORG=… DAYS=…` — still you-in-the-loop. |
| 50+       | Hosted issuer: Stripe "subscription created" webhook → signer → emails the key. Hands-off.            |

Don't automate before manual issuance is genuinely a chore — that's a real signal, not a guess.

### Rotation

The public key is baked into each release, so rotating means cutting a new release and re-issuing active
customers. Rotate only on compromise. Post-v0.9.0, baking **two** accepted public keys (current + next)
lets you roll over without a flag-day.

## What's gated (and the roadmap)

The licensing **mechanism** is open core (inspectable, FSL) — only the **features** under `ee/` are gated:

- **Today:** the activation gate + an example gated feature (audit event recording).
- **v0.9.0+ roadmap** (the reliably enterprise-only set): **SSO/SAML, SCIM, RBAC / team permissions,
  audit logs, multi-org management, verify-before-merge policy gates, and the hosted control-plane
  connectors.** These are the things a security/compliance org pays for; the core verification engine
  stays free forever.

> What's premium vs free, and pricing, are business decisions for the owner — this doc describes the
> _mechanism_, not the price list.

## Security & data handling

The honest one-pager a security review needs. Iris is built so the answer to "where does our data go?"
is **nowhere — it runs on your machine, in your infra.**

| Question                         | Answer                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Does the SDK ship to production? | **No** — dev/preview-only, tree-shaken from production builds.                                                                                               |
| Where does the server run?       | **Localhost** — the bridge binds `127.0.0.1`; the verify endpoint is localhost-bound + token-guarded (constant-time), with request/body-size/timeout limits. |
| Does anything phone home?        | **No telemetry.** Nothing is sent to Syrin — including license checks (offline Ed25519).                                                                     |
| Where do artifacts live?         | Your disk: `.iris/runs/<id>.json` (atomic writes, bounded retention), `.iris/flows/`, `.iris/contract.json`. You own them.                                   |
| What can the server read?        | The DOM/network/console/routing/state of the app under test — locally.                                                                                       |
| Leak risk downstream?            | The **`prod-preview` profile** redacts source `file:line`, raw bodies, and app-state values.                                                                 |
| Path safety                      | Run/flow ids are validated as single path segments on read **and** write (no traversal).                                                                     |

**Verify it yourself:** the SDK + server are source-available — read the tree-shaking, the `127.0.0.1`
bind, and the offline license verify. `SECURITY.md` has the disclosure process; an SBOM is available on
request. SOC 2 is a GA-stage item (no Iris-hosted data exists today to certify); the posture above is the
honest current state.

## Licensing model (per package)

| Scope                                                                                                   | License                     | Why                                                                             |
| ------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------- |
| Embeddable SDK (`browser`, `protocol`, `react`, `babel-plugin`, `next`, `vite-plugin`, `eslint-plugin`) | **Apache-2.0**              | safe to ship inside your customers' apps; explicit patent grant                 |
| Server / CLI / MCP (`server`, `test`, umbrella)                                                         | **FSL-1.1-ALv2**            | free for any use except reselling Iris itself; converts to Apache after 2 years |
| Enterprise features (`packages/server/src/ee/`)                                                         | **Iris Enterprise License** | source-available; free for dev/eval, license key required in production         |

Embedding / OEM / enterprise: **hey@syrin.ai**.
