---
name: verify-keyboard-access
description: Verify that every interactive control on a page can take keyboard focus and that its primary action fires from the keyboard rather than only the mouse, and say plainly that Tab order cannot be verified today. Use when a component was hand-tested with a mouse, a custom dropdown/modal/combobox was added, or an accessibility report flags an unreachable control.
license: Apache-2.0
metadata:
  version: 3.7.0
  homepage: https://www.reticle.sh
  repository: https://github.com/reticlehq/reticle
---

# Reachable is not the same as operable

A `<div onClick>` styled to look like a button can look reachable (plenty of component libraries hand out `tabindex="0"` for free) and still do nothing when you press Enter on it. Being able to take focus proves a control is reachable, not that it works.

**Reticle** can drive both halves in the running app. Not installed? `RETICLE_INSTALL_SOURCE=npx_skill npx @reticlehq/server@latest init`, then the [`install-and-verify`](https://github.com/reticlehq/reticle/blob/main/skills/install-and-verify/SKILL.md) skill.

## Read this before you start: Tab order cannot be verified today

`press` always goes through a synthetic key event, and a synthetic Tab does not move focus. That is true in every mode, including `reticle drive`: there is no mode in which an agent can prove focus order. Do not go looking for one, and do not report a Tab-order result as passed or failed. Report it as **unknown**.

What this skill can prove is narrower: that each control can take focus, and that its primary action fires from the keyboard.

## Confirm the session is healthy

Confirm a live session exists for the page and can render and observe:

```
reticle_session({ action: "list" })
```

In a disconnected, hidden or throttled tab, a key press can be accepted while timers, rendering and later observation do not advance, so nothing you read back is trustworthy. Get a usable context first, for example a leased tab:

```
reticle_run({ tool: "reticle_lease", args: { action: "acquire", url } })
```

Pass `refuseWhenThrottled: true` on the action so a paused tab fails loudly instead of silently doing nothing. If you cannot get a healthy session, report the run as **blocked**, not passed, and do not keep retrying against it.

## List the controls

List every interactive control before touching the keyboard, or you will only test the ones you already knew about:

```
reticle_look({ sessionId, action: "page", mode: "interactive" })
```

## Check that each control can take focus

For each control from that list, focus it and assert that it took focus:

```
reticle_act({ sessionId, ref, action: "focus" })
reticle_assert({
  sessionId,
  predicate: { kind: "element", query: { testid: "the-control" }, state: "focused" },
})
```

That proves the control can take focus. It does not prove the control sits in the Tab order (`tabindex="-1"` is focusable but skipped by Tab), so report it as focusable, not Tab-reachable. A `<div onClick>` with no `tabindex` will not take focus, and that is a real finding.

## Prove the primary action, not just the focus

Focus is a precondition, not the check. Name the consequence, then activate with the keyboard:

```
reticle_act_and_wait({
  sessionId,
  ref,
  action: "press",
  args: { text: "Enter" },
  until: { kind: "element", query: { testid: "expected-result" } },
})
```

Buttons and links take Enter. Checkboxes and native `<select>` take Space, plus arrow keys for the options. A synthetic Enter on a form control does submit its form, so Enter-to-submit is checkable here. A custom-styled combobox is the control most likely to fail: it looks identical to the native one and often only listens for `click`. Press the key. Do not substitute a click and assume the keyboard would behave the same.

An `until` can already be true before you act, and then `already_true` proves nothing about your key press. Check the consequence is absent first. If it is not, reset the app state and start again, or report the result as inconclusive. If the requirement is that text becomes visible, use a predicate that requires visibility, since a hidden element still satisfies a presence check. Load the exact fields with `reticle_tools({ names: ["reticle_act_and_wait"] })` rather than guessing.

## What to assert

1. **Every control from the initial look can take focus**, each proven by a `focus` action and a `state: "focused"` assert.
2. **The primary action fires from the keyboard**, proven by `reticle_act_and_wait({ until })` naming a consequence that was not already true.

Tab order and focus traps are not on this list. Neither can be verified today, so report both as **unknown**, never as passed.

## Honesty

Report each result as **verified** (Reticle returned a positive verdict for the exact condition), **failed**, **blocked** (no healthy session) or **unknown**. A verdict of `verified: "unknown"` or `verified: "no-fault"` is not a pass. `unknown` means Reticle could not tell what happened. Report either as it is, and never weaken a check to make it pass. Observed evidence is not a verified result, `already_true` is not proof your action caused the consequence, and a key press that was dispatched but never settled is not a completed interaction.

Finish with the controls found, which of them took focus, the key you pressed and the exact consequence you waited for, the verdict Reticle returned, that Tab order is unknown, and any throttling or timeout that limits the result.

---

Capability reference: `curl https://docs.reticle.sh/capabilities.md`. Everything else: `curl https://docs.reticle.sh/llms.txt`.
