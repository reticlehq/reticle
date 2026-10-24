---
title: 'Production mode'
description: 'Let an agent drive your live site under a policy that refuses payments, deletions, invites and role changes.'
icon: shield
---

Production mode lets an agent drive a live site, not only a development build. It is opt-in. It is dormant until you activate it for one drive. A visitor who did not activate it gets no SDK, no socket and no prompt.

## What you need

- A Reticle service that issues activation tickets (`POST /v1/production-mode/tickets`). A service without this route answers 404, and the lease says "the server does not offer production mode".
- This project linked to that service: `reticle connect`, or `RETICLE_API_KEY`.
- The loader in your site's staging and production builds (below). It checks the ticket in the page, with the service's public key.
- A browser that is signed in to the site, as the person whose API key asks for the ticket. The service issues a ticket only for that person, in that workspace. A leased browser starts signed out, so give the lease your session cookies in `seedStorage` (see below).

## Install the loader on staging and production

Call `activate` once, at startup, with the public key that the dashboard shows you:

```ts
import { activate } from '@reticlehq/browser/activate';

void activate({ publicKey: '<the public key from the dashboard>' });
```

In Vite, put it in `main.ts`. In Next.js, put it in a client component that the root layout renders, inside a `useEffect`.

A visitor's page load reads one query parameter and stops. It loads no SDK, opens no socket, and writes no storage and no DOM. Only a URL with a valid `reticle_activate` ticket loads the SDK. The loader then removes the parameter from the address bar and connects with the ticket's nonce, bridge and scope. The loader refuses a ticket that has a bad signature, that expired, that is for another origin, or whose bridge is not `wss://` (`ws://` only on a loopback host). A refused ticket loads nothing and writes one `console.warn` line.

The session reads as an installed SDK, not an injected one.

### The ticket

The ticket is `<payload>.<signature>`, both base64url. The payload is JSON: `{ v: 1, nonce, origin, bridge, scope, exp }`, where `exp` is epoch ms. The signature is Ed25519 over the ASCII bytes of the payload part. A service mints tickets with `signActivationTicket(privateKey, payload)` from `@reticlehq/core`. The page checks them with `verifyActivationTicket`.

## Activate a drive

One `reticle_lease` call does it:

```json
{
  "action": "acquire",
  "url": "https://app.example.com/",
  "seedStorage": { "cookies": { "<session cookie name>": "<value>" } },
  "production": {
    "workspaceId": "ws_123",
    "scope": "act",
    "intent": "create a project, then delete it"
  }
}
```

The daemon then does three things:

1. It mints a single-use session nonce for the site's origin. The nonce expires after 60 minutes.
2. It asks the service for a ticket with the linked API key: `{ workspaceId, nonce, bridgePort, scope, origin, bridge }`. `origin` is the site's origin and `bridge` is the bridge the page dials (`ws://127.0.0.1:<port>/reticle`). The service signs the ticket for exactly those two values. It also decides who may activate.
3. It opens `https://app.example.com/?reticle_activate=<ticket>` in a leased browser.

A host that embeds the engine and runs its own bridge passes its cloud link as `ToolDeps.linkedCloud`, and its bridge as `bridgePort` and `nonces`. It needs no `cloud.json`. Such a host must not inject the SDK into a production lease's browser context. An injected copy connects first, as a development session, and the loader's `connect` then does nothing.

If no page connects, the lease answers `ready: false`. The usual cause is a signed-out browser: the service refused the ticket, and the page loaded without an activation. Release the lease, then acquire again with your session cookies in `seedStorage`.

The page connects with the nonce. The daemon accepts a production HELLO only with a live production nonce, never with the machine's pairing token. The first tab that presents the nonce owns it. That tab can reconnect after a reload. Another tab is refused.

## What the policy refuses

The daemon enforces the policy where it sends commands, not in the page.

**Scope `observe`** refuses every act. The agent can still look, observe, assert and navigate.

**Scope `act`** refuses these actions, unless the drive's `intent` names the action:

| Rule                          | Examples                                             |
| ----------------------------- | ---------------------------------------------------- |
| payment or checkout           | Upgrade, Pay, Add card; `POST /billing`, `/checkout` |
| delete a workspace or project | Delete project; `DELETE /projects/:id`               |
| revoke or rotate a key        | Revoke key, Rotate secret; `DELETE /keys/:id`        |
| send an invite or email       | Send invite, Resend; `POST /invites`                 |
| cancel a subscription         | Cancel subscription; `DELETE /subscriptions/:id`     |
| change a member's role        | Make admin, a Role picker; `PATCH /members/:id`      |

The daemon recognises an action in two ways:

- **The control.** Its name, text, value, test id, link and form target.
- **The request.** Its method and path, from a policy list. The service can send its own list with the ticket. Without one, the daemon uses `DEFAULT_PRODUCTION_POLICY` from `@reticlehq/core`.

In a leased browser, each request the page sends passes the policy before it leaves the browser. A refused request gets a 403 and never reaches the site.

A key press on a production drive runs in the page, never on the native keyboard. A native key goes to the control that has focus, so the policy could not see it. The policy judges a key press by the control it names. A key press that names no control is judged only by the requests it sends.

These are always allowed:

- navigation on the activated origin (leaving the origin is refused);
- reading, filters, tabs and panels;
- deleting something the drive itself created. The daemon notes the ids that the drive's own creates returned (a 2xx `POST` or `PUT` whose body has an `id`).

An intent with a negation asks for nothing: "she does not invite anybody" does not allow an invite.

## What a refusal looks like

A refusal is never a silent no-op. The act fails, and its error names the rule:

```
refused: production policy: send an invite or email. A production drive does this only when its
declared intent names it (reticle_lease production.intent).
```

The drive ends when the nonce expires. After that, every act is refused with `the session nonce expired`, and the page cannot reconnect.
