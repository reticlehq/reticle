---
title: 'Production mode'
description: 'Let an agent drive your live site under a policy that refuses payments, deletions, invites and role changes.'
icon: shield
---

Production mode lets an agent drive a live site, not only a development build. It is opt-in. It is dormant until you activate it for one drive. A visitor who did not activate it gets no SDK, no socket and no prompt.

## What you need

- A Reticle service that issues activation tickets (`POST /v1/production-mode/tickets`). A service without this route answers 404, and the lease says "the server does not offer production mode".
- This project linked to that service: `reticle connect`, or `RETICLE_API_KEY`.
- The site loads `@reticlehq/browser` lazily, only when an activation is present, and calls:

  ```ts
  reticle.connect({
    port, // from the activation
    token: nonce, // the session nonce, never the pairing token
    allowInProduction: true,
    allowNonLocalhost: true,
    env: 'production',
    scope, // "observe" or "act"
  });
  ```

## Activate a drive

One `reticle_lease` call does it:

```json
{
  "action": "acquire",
  "url": "https://app.example.com/",
  "production": {
    "workspaceId": "ws_123",
    "scope": "act",
    "intent": "create a project, then delete it"
  }
}
```

The daemon then does three things:

1. It mints a single-use session nonce for the site's origin. The nonce expires after 60 minutes.
2. It asks the service for a ticket with the linked API key: `{ workspaceId, nonce, bridgePort, scope }`. The service decides who may activate, and signs the ticket.
3. It opens `https://app.example.com/?reticle_activate=<ticket>` in a leased browser.

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
