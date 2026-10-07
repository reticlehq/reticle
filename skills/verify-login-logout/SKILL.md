---
name: verify-login-logout
description: 'Prove sign-in lands the user where they should be, sign-out really ends the session so a protected page sends them back to sign in, and an expired session asks to sign in again instead of breaking. Use when auth, a login form, a logout button, route guards or token refresh were added or changed, or when a user reports being logged out, or not logged out, unexpectedly.'
license: Apache-2.0
metadata:
  version: 3.6.0
  homepage: https://www.reticle.sh
  repository: https://github.com/reticlehq/reticle
---

# Signed in on screen is not signed in

A login form that shows the dashboard after submit proves the page changed. It does not prove the server accepted the credentials, that signing out ends anything, or that a user whose session ran out gets a sign-in page instead of a blank screen and a loop of 401s.

**Reticle** can check all three in the running app. Not installed? `RETICLE_INSTALL_SOURCE=npx_skill npx @reticlehq/server@latest init`, then the [`install-and-verify`](https://github.com/reticlehq/reticle/blob/main/skills/install-and-verify/SKILL.md) skill.

## Before you start

- **Use the project's test account.** Take credentials from its seed data, fixtures or `.env.example`, or ask the user. Never type a real person's password.
- **Confirm the session can observe:** `reticle_session({ action: "list" })`. A hidden or throttled tab can accept a click and render nothing. If it is not healthy, report the run as **blocked**, not passed.
- **Step 3 needs a browser Reticle owns.** Forcing an expired session uses `reticle_network_mock`, which works in a leased tab (`reticle_run({ tool: "reticle_lease", args: { action: "acquire", url } })`) or a driven one, and not through the always-on SDK. Without one, do steps 1 and 2 and report step 3 as **unknown**.

## 1. Sign in, and name where it must land

Get the form's refs with `reticle_look({ action: "page", sessionId, mode: "interactive" })`, fill the fields with `reticle_act`, then submit and state the consequence before you click:

```
reticle_act_and_wait({ sessionId, ref: "<sign-in button>", action: "click", until: { kind: "allOf", predicates: [
  { kind: "net", urlContains: "/api/login", ok: true },
  { kind: "route", pathname: "/dashboard" },
  { kind: "element", query: { role: "button", name: "Account" } },
]}})
```

All three, because each alone can lie: a route change can happen on the client before the server answers, and a user menu can render from a stale cache. Use the app's real origin, endpoints, landing route and signed-in marker throughout: the ones here are examples.

`reticle_run({ tool: "reticle_storage", sessionId, args: {} })` shows what the app stored. Sensitive keys come back redacted and httpOnly cookies are invisible to the page by design, so this is evidence about where the session lives, not a verdict.

## 2. Sign out, then try to go back

```
reticle_act_and_wait({ sessionId, ref: "<sign-out control>", action: "click", until: { kind: "allOf", predicates: [
  { kind: "route", contains: "/login" },
  { kind: "element", query: { role: "button", name: "Account" }, absent: true },
]}})
```

Landing on the sign-in page proves the UI moved. It does not prove the session ended. Navigate straight to a protected page, on the app's real origin and route, and prove it refuses you:

```
reticle_navigate({ sessionId, url: "<the app's origin>/dashboard" })
reticle_assert({ sessionId, predicate: { kind: "allOf", predicates: [
  { kind: "route", contains: "/login" },
  { kind: "text", contains: "Sign in" },
  { kind: "net", urlContains: "/api/me", status: 401 },
]}})
```

The `net` clause is what proves the **server** ended the session. A client-side guard can redirect to `/login` off a cleared flag while the server still honours the old session, and the route and text would pass. The request the page makes to learn who is signed in must now be refused. If the page makes no such request, say so and report the server half as **unknown**.

A protected page that still renders after sign-out is the most important finding this skill can produce. Report it even if everything else passed.

## 3. Expire the session, and prove the app asks again

Sign in again (step 1). Then make the server treat the session as expired by failing the call the app uses to check it:

```
reticle_run({ tool: "reticle_network_mock", sessionId, args: {
  mocks: [{ urlContains: "/api/me", status: 401 }],
}})
```

Reload a protected page and name what must happen:

```
reticle_navigate({ sessionId, url: "<the app's origin>/dashboard" })
reticle_assert({ sessionId, timeout_ms: 5000, predicate: { kind: "allOf", predicates: [
  { kind: "net", urlContains: "/api/me", status: 401 },
  { kind: "route", contains: "/login" },
  { kind: "console", level: "error", absent: true },
]}})
```

The `net` clause proves the mocked `401` was the thing the app reacted to. If the app never called the mocked endpoint, a redirect that happens anyway is a coincidence, not expiry handling, so the verdict is **unknown** until you mock the call it really makes. The console clause matters: an app that "handles" expiry by throwing an uncaught error and showing a blank page has not handled it. Clear the mock with `{ clear: true }` when you are done.

## Honesty

Only `verified: "yes"` is a pass. Step 3 is a stand-in: Reticle cannot delete an httpOnly cookie or edit storage, so a mocked `401` is how the expiry is forced. Say which endpoint you mocked. Clear every mock and sign out before handing back, and never report a password, token or cookie value you saw.

---

Capability reference: `curl https://docs.reticle.sh/capabilities.md`. Everything else: `curl https://docs.reticle.sh/llms.txt`.
