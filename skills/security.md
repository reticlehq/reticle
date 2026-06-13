# skills/security.md — Security & Privacy

**Open when:** touching the bridge transport, action execution, or data capture.
(Foundation II.4 + `plan/08`.)

## Posture: dev-only, localhost-only, opt-in, redacted

Iris instruments a live app and exposes its internals. That power is fenced:

- **Dev-only by construction.** The SDK no-ops unless enabled; tree-shaken out of prod
  (`if (import.meta.env.DEV)`). Loud warning if it initializes on a non-localhost origin.
- **Localhost-only transport.** Bridge binds `127.0.0.1`. Remote use needs explicit opt-in
  plus a pairing token.
- **Pairing token.** Browser SDK and bridge share a token so a random page can't connect.
- **Same-origin.** The SDK instruments only its own page.

## Action safety tiers (WebMCP-style)

Read-only tools (snapshot/query/observe/assert) run freely. State-changing `act` honors a
**blocklist** (never auto-click "Delete account") and an optional confirm gate. Implement the
blocklist check in the executor, not just the route — defense at the boundary that acts.

## Redaction before anything leaves the browser

- Network bodies are **not** captured by default — method/url/status/timing only.
- When body capture is opted in, run a redactor first: drop/mask `password`, `token`,
  `secret`, `authorization`, `card`, `cvv`, `ssn` + user patterns. Same for component props
  and signal payloads.
- Offer `maskText` snapshot mode (`"•••• 4242"`) to keep structure without PII.

## Constant-time comparison for the pairing token

Compare the pairing token with `crypto.timingSafeEqual`, never `===`. A `===` comparison on
a secret leaks it via timing (Foundation II.4). This is correctness for secrets, not an
optional hardening.

## Never break the host app

Observers patch globals (`fetch`, History, `console`). They must be additive, defensive
(try/catch around every patch), and fully reversible on `iris.disconnect()`. Breaking the
app under test destroys trust instantly — this is a hard rule.
