# The verify loop

Look, act, observe, assert. Only the last one counts.

## 1. Connect

```
reticle_sessions()
```

The first live call blocks until the SDK connects, so this is also how you wait after starting a dev server.

- **One session**: proceed.
- **No sessions**: read the `why` field. The daemon can tell "no app is running" from "an app is running that never dialled this daemon" from "a tab was here and closed", and each has a different fix. Then work [troubleshooting.md](troubleshooting.md). Do not stop at "no app connected"; that branch is where most sessions die and it is worth one more call before it does.
- **Multiple sessions**: list them with `sessionId` and `url`, ask which one, then pin `sessionId` on every subsequent call.

## 2. Orient

Cheapest orientation first.

```
reticle_run({ tool: "reticle_capabilities", sessionId })   // ~1 KB, the app's whole testable surface
reticle_snapshot({ sessionId, mode: "interactive" })       // just the controls, with refs
```

`reticle_capabilities` returns every registered testid, every domain signal, the registered stores, and the named flows with their steps. That is the app describing itself in its own vocabulary before you touch it. `reticle_capabilities({ fromDisk: true })` returns the same manifest from the checked-in `.reticle/contract.json` with no browser attached at all.

**Do not open with `reticle_network` or `reticle_console`.** They read a buffer that predates your action, so they answer a question you have not asked yet. Read them after an act, scoped by `since`.

Two more that nothing else replaces:

- `reticle_scroll_to`: the only way to reach a row a virtualised list has not mounted. A `query` that misses it is not evidence the row is absent.
- `reticle_storage`: what the app persisted. The difference between "logged in" and "looks logged in".

**There is one tool surface and nothing to choose.** The verify loop is advertised directly. Everything else is one hop away: `reticle_run({ tool, args })` invokes any tool by name and `reticle_tools` lists them. `reticle_run` takes `sessionId` at the top level and forwards it.

Call out any pre-existing console errors before you test anything.

## 3. Act, and declare the consequence in the same hop

This is the default. It names the expected consequence **before** the result exists, which is the difference between a check and a rationalisation.

```
reticle_act_and_wait({ sessionId, ref, action: "click", until: { kind: "allOf", predicates: [
  { kind: "net",     method: "POST", urlContains: "/api/...", status: 200 },
  { kind: "element", query: { role: "...", name: "..." }, state: "visible" },
  { kind: "console", level: "error", absent: true }
]}})
```

Only when the consequence lands somewhere you cannot name up front, act bare and assert after, always with `since` from the act result or the assertion silently reads the wrong window:

```
reticle_act({ sessionId, ref, action: "click" })
reticle_assert({ sessionId, since, timeout_ms: 5000, predicate: { ... } })
```

## 4. Read the verdict

Every verdict carries `verifiedReason` and `because`. They name the next move.

| verdict | means | do |
| --- | --- | --- |
| `yes` / `proved` | the declared consequence held and nothing disagreed | report it, move on |
| `no` / `assertion_failed` | the consequence did not hold | a real failure, report with `because` |
| `no` / `contradicted` | a channel observed something incompatible: a request failed while the UI advanced, a signal disagreed with the DOM, a field echoed a different value | this is the false green Reticle exists to catch, report it and do not retry |
| `unknown` / `unsettled` | your assertion held but the window closed before the app finished | **re-assert, do not re-drive**: `reticle_assert({ predicate, since, timeout_ms: 8000 })` with the `since` from the act result. Re-driving repeats a side effect that already happened |
| `unknown` / `unclean_capture` | evidence was lost from the window | re-run the single action; if it persists, say so, it is a Reticle limitation and not an app fault |
| `unknown` / `outcome_unread` | a 2xx body was never read by the app | usually a real app bug, report as unknown with the reason |

**`unknown` is not a pass.** It means Reticle drove the app and could not tell what happened. Report it as unknown and say why. Do not round it up.

**Never weaken a check to turn a verdict green.** An assertion edited until it passes proves nothing, and it is the exact failure this tool exists to prevent.

## 4b. Assert what a field CONTAINS, not just that it exists

An element predicate checks `value` and `text`, so a form field's contents are directly assertable:

```jsonc
{ "kind": "element", "role": "textbox", "name": "GST amount", "value": "274.58" }
```

A failure names the assertion (`element.value`), what it observed, and what you claimed, so you can act on it without a second call.

Two things follow.

**Prefer this over reading a value and comparing it yourself.** Fetching the value with `reticle_query` and eyeballing it in your reply produces no verdict, so it does not count as verification however careful the comparison was.

**A locator is not a conjunction.** An element query dispatches on the first field it recognises, so a field it does not use is not a silent extra condition. `value` and `text` are checked; `label`, `placeholder`, `testid`, `alt`, `component`, and a `by` without a `value` are refused rather than ignored when something else already selected the element. A refusal costs you a turn. A silent pass would cost you the bug.

## 5. Batch, do not ping-pong

The repeat loop is cheap; the expensive part is the first drive of a surface you have not seen. Every extra round trip pays the advertised tool surface again, so a cheap first drive means fewer and bigger hops, not smaller ones.

State the whole journey with `reticle_act_sequence`, then assert its consequence once. Do not act, snapshot, act, snapshot.

## 6. Read program truth, not the DOM

`reticle_state` returns what the app **believes**. That is the class of bug a screenshot cannot see: a stale TanStack Query cache served as fresh fires no network request, so the network log shows silence and the DOM shows a plausible number. The cache is the only witness.

If `reticle_state` comes back empty or `hasCapabilities` is false, no store was registered. Say so; do not treat an empty state read as a clean one. See setup.md for the registration table.

## 7. Check what you did not touch

A drive that only exercises the changed component proves the changed component. Before reporting, name what else the change could have affected and either check it or say you did not.

## 8. Report

Say what you drove, what the verdict was, and `file:line` for anything broken. Report `unknown` as unknown.
