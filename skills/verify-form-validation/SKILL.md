---
name: verify-form-validation
description: 'Check that a form actually rejects bad input: the error message renders, the submit button stays disabled, and no request goes out. Use when validation logic was written but never driven, when a "required" or pattern check looks right on screen but was never proven, or when a bug report says the form submitted invalid data anyway.'
license: Apache-2.0
metadata:
  version: 3.3.0
  homepage: https://www.reticle.sh
  repository: https://github.com/reticlehq/reticle
---

# A rejected form still looks fine on screen

Validation code is written once, glanced at in the browser with one obviously-bad value, and never driven again. The bug that ships is never the value you tried; it's the one you didn't: a field that's required but not marked `disabled` until blur, a submit button whose `disabled` is CSS-only, or a handler that fires the request before the check finishes.

**Reticle** can drive the real form and check all three failure points at once. Not installed? `RETICLE_INSTALL_SOURCE=npx_skill npx @reticlehq/server@latest init`, then the [`install-and-verify`](https://github.com/reticlehq/reticle/blob/main/skills/install-and-verify/SKILL.md) skill.

## Read this before you start: the browser's own validation can mask the app's

`required`, `pattern`, `type="email"` and friends stop the browser at the constraint-validation bubble before your app's JS ever runs. If you assert on that native tooltip, you've verified the browser, not the code you're supposed to be testing. Confirm the error you're checking is the app's own element (a `testid`, a role, a rendered string), not a `:invalid` pseudo-state, before you trust the verdict. If the form relies on native validation alone with no app-level check behind it, that's the finding: say so, don't paper over it with a predicate that happens to pass.

## Trigger the rejection

Name the consequence before you act, same as any Reticle drive:

```
reticle_look({ action: "page", sessionId, mode: "interactive" })   // get refs for the field and submit control

reticle_act_and_wait({ sessionId, ref, action: "fill", args: { value: "<invalid>" }, until: { kind: "allOf", predicates: [
  { kind: "element", query: { testid: "field-error" } },
  { kind: "element", query: { role: "button", name: "Submit" }, state: "disabled" },
]}})
```

If the check is debounced or runs on blur rather than on keystroke, don't sleep for it; use `reticle_act` for the blur/tab-out as its own step inside the same call, or use `reticle_clock` to advance past the debounce window exactly as in [`test-error-states`](https://github.com/reticlehq/reticle/blob/main/skills/test-error-states/SKILL.md#skip-time-instead-of-sleeping). A fixed sleep passes on your machine and flakes in CI.

## Prove nothing fired

The button looking disabled is not the same claim as the request never leaving. Assert the negative explicitly:

```
reticle_assert({ sessionId, since, predicate: {
  kind: "net", method: "POST", urlContains: "/api/...", count: 0,
}})
```

Use `since` from the act result so you're not reading a request that fired before you started. A `count: 0` check that runs before the app has had a chance to fire the request proves nothing; give it the same window you gave the error to appear.

## Clear the error

Correct the value and confirm the rejection was conditional, not permanent:

```
reticle_act_and_wait({ sessionId, ref, action: "fill", args: { value: "<valid>" }, until: { kind: "allOf", predicates: [
  { kind: "element", query: { testid: "field-error" }, absent: true },
  { kind: "element", query: { role: "button", name: "Submit" }, state: "enabled" },
]}})
```

A form that never re-enables once it has rejected something once is a second bug wearing the first one's clothes.

## What to assert

1. **The error is the app's own**, not the browser's native bubble.
2. **The submit control's `disabled` state is real**, not `opacity`/`cursor` styling that only looks inert; this is the same distinction [`design-system-compliance`](https://github.com/reticlehq/reticle/blob/main/skills/design-system-compliance/SKILL.md) draws between disabled-looking and disabled.
3. **Zero matching requests fired**, counted, not inferred from "no error was thrown."
4. **The rejection is conditional**: a valid value clears the error and re-enables submit.

## Honesty

A verdict here is about this field and this invalid value, not the whole form. A required-field check tells you nothing about a pattern check on a different field. If you only drove one input, say which one, and say the rest of the form is unverified rather than letting a single pass read as "the form validates."

---

Capability reference: `curl https://docs.reticle.sh/capabilities.md`. Everything else: `curl https://docs.reticle.sh/llms.txt`.