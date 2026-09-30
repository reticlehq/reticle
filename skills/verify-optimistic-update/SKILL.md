---
name: verify-optimistic-update
description: 'Prove a UI that updates before the server answers puts things back and says so when the request fails, and keeps the change when it succeeds. Use when a like, toggle, rename, reorder, delete or add-to-cart updates instantly, when an optimistic update was added or changed, or when a user reports a change that "saved" but was gone after a reload.'
license: Apache-2.0
metadata:
  version: 3.3.0
  homepage: https://www.reticle.sh
  repository: https://github.com/reticlehq/reticle
---

# An optimistic update is a promise the server can break

Updating the UI before the server answers makes an app feel fast. It also means the UI claims something the server has not agreed to yet. The failure path, where the request fails and the UI has to take the claim back, is the one nobody clicks through, because on a working backend it never happens.

**Reticle** can make it happen in the running app. Not installed? `RETICLE_INSTALL_SOURCE=npx_skill npx @reticlehq/server@latest init`, then the [`install-and-verify`](https://github.com/reticlehq/reticle/blob/main/skills/install-and-verify/SKILL.md) skill.

## Read this before you start: failing a request needs a browser Reticle owns

`reticle_network_mock` works in a leased tab (`reticle_run({ tool: "reticle_lease", args: { action: "acquire", url } })`) or a driven one, and not through the always-on SDK, which answers `{ ok: false, reason: "no-cdp-provider" }`. Without one, do step 4 (the success path) and report the rollback as **unknown**. Driving the happy path and reporting that rollback works is the one thing you may not do.

Confirm the session can observe first: `reticle_session({ action: "list" })`. A hidden or throttled tab can accept a click and render nothing.

## 1. Make the save fail, slowly

```
reticle_run({ tool: "reticle_network_mock", sessionId, args: {
  mocks: [{ urlContains: "/api/todos", method: "PATCH", status: 500, delayMs: 1500 }],
}})
```

The delay is what makes the optimistic state observable. Without it the failure can land before anything is on screen, and you cannot tell "rolled back" from "never updated".

## 2. Act, and prove the optimistic state appears

Get the control's ref with `reticle_look({ action: "page", sessionId, mode: "interactive" })`, then name the optimistic state before you click:

```
reticle_act_and_wait({ sessionId, ref: "<rename or toggle>", action: "click", until:
  { kind: "text", contains: "Buy oat milk" }
})
```

This proves the UI updated before the server answered. It is the claim the next step checks is taken back.

## 3. Prove it reverts, and says why

Once the request has failed, the new value must be gone, the old one back, and the user told:

```
reticle_assert({ sessionId, timeout_ms: 5000, predicate: { kind: "allOf", predicates: [
  { kind: "net", urlContains: "/api/todos", method: "PATCH", status: 500 },
  { kind: "text", contains: "Buy oat milk", absent: true },
  { kind: "text", contains: "Buy milk" },
  { kind: "element", query: { role: "alert" } },
  { kind: "console", level: "error", absent: true },
]}})
```

If the app keeps its state in a registered store, check the store too, because a UI can roll back on screen while the store keeps the optimistic value:

```
reticle_assert({ sessionId, predicate: { kind: "state", path: "todos.0.title", equals: "Buy milk" } })
```

## 4. Remove the mock, and prove success sticks

```
reticle_run({ tool: "reticle_network_mock", sessionId, args: { clear: true } })
reticle_act_and_wait({ sessionId, ref: "<rename or toggle>", action: "click", until: { kind: "allOf", predicates: [
  { kind: "net", urlContains: "/api/todos", method: "PATCH", ok: true },
  { kind: "text", contains: "Buy oat milk" },
]}})
```

Then reload and prove the server kept it, which is what "saved" means:

```
reticle_navigate({ sessionId, url: "http://localhost:3000/todos" })
reticle_assert({ sessionId, predicate: { kind: "text", contains: "Buy oat milk" } })
```

## Honesty

Only `verified: "yes"` is a pass. A verdict taken under a mock is about the mocked condition, so say which endpoint you failed and with what status. Clear every mock before handing back, or the next session sees a backend that fails every save.

---

Capability reference: `curl https://docs.reticle.sh/capabilities.md`. Everything else: `curl https://docs.reticle.sh/llms.txt`.
