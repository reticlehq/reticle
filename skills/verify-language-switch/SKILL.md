---
name: verify-language-switch
description: 'Prove a language switch translates what the user sees, keeps what they had already typed, and is still in force after a reload. Use when i18n, a locale picker, a language menu or translation files were added or changed, when a string is suspected of staying in the old language or showing a raw translation key, or when a user reports losing their form or their language choice after switching or refreshing.'
license: Apache-2.0
metadata:
  version: 3.7.0
  homepage: https://www.reticle.sh
  repository: https://github.com/reticlehq/reticle
---

# A translated heading is not a translated page

Clicking the language menu and seeing one word change proves one string was wired up. It does not prove the rest of the page followed, that the field the user was in the middle of filling still holds what they typed, or that the choice outlives a refresh. Those are three separate bugs. Each ships regularly, and glancing at the page after the click catches none of them.

**Reticle** can prove all three in the running app, with no test code. Not installed? `RETICLE_INSTALL_SOURCE=npx_skill npx @reticlehq/server@latest init`, then the [`install-and-verify`](https://github.com/reticlehq/reticle/blob/main/skills/install-and-verify/SKILL.md) skill.

## Before you start

- **Confirm the session can observe:** `reticle_session({ action: "list" })`. A hidden or throttled tab can accept a click and render nothing. If it is not healthy, report the run as **blocked**, not passed.
- **Take the expected strings from the app, not from your head.** Open its translation files (`locales/`, `messages/`, `i18n/`) and copy the target-language value for each string you will assert on. A translation you guessed can fail on a correct app, and one you half-remember can pass on a wrong one.
- **Pick strings that are not already on the page.** A language menu that lists "Español" satisfies `{ kind: "text", contains: "Español" }` before you click, and the verdict comes back `already_true`. Assert on the translated heading or a nav label instead, and `scope` the predicate to the region it lives in.

## 1. Note what is on screen, and type something

```
reticle_look({ action: "page", sessionId })
```

Write down two or three visible strings in the current language from **different regions** of the page: the heading, a nav label, a button. One string proves one component; two regions prove the switch reached the page.

Then type a value into a form field, so step 3 has something to find:

```
reticle_look({ action: "page", sessionId, mode: "interactive" })
reticle_act({ sessionId, ref: "<a text field>", action: "fill", args: { value: "reticle-i18n-4471" } })
```

The result must show `valueChanged: true`. Use a value nothing else on the page contains, so step 3 proves **this** input survived rather than a default being refilled.

## 2. Switch, and name what must change before you act

Get the switch control's ref from the interactive look. A `<select>` takes `action: "select"` with `{ value }`; a button or menu item takes `click`.

```
reticle_act_and_wait({ sessionId, ref: "<language control>", action: "select", args: { value: "es" }, until: { kind: "allOf", predicates: [
  { kind: "text", contains: "<heading in the new language>", scope: "h1" },
  { kind: "text", contains: "<heading in the old language>", absent: true },
  { kind: "text", contains: "<nav label in the new language>", scope: "nav" },
  { kind: "text", contains: "<the heading's translation key, e.g. home.title>", absent: true },
  { kind: "console", level: "error", absent: true },
]}})
```

Each clause catches a different bug. New text present **and** old text absent proves the switch replaced the string rather than rendering both. The second region proves it was not one component. The translation-key clause catches the string that fell back to its key because the target locale is missing it. The console clause catches the i18n library reporting a missing key as an error. If yours reports at `warn`, add `{ kind: "console", level: "warn", contains: "missing", absent: true }`.

If the app stores the choice on the server, add `{ kind: "net", urlContains: "/api/preferences", ok: true }` with the app's real endpoint, so a switch that only changed the client is not reported as saved.

**If the switch is a full page load** (a `?lang=es` query or an `/es/` prefix that reloads the document), the SDK is torn down mid-wait and this verdict will be `unknown`. Use `reticle_navigate({ sessionId, url: "<the app's origin>/es/<route>" })` and run the text assertions on the session that comes back. Then report step 3 as **lost by design**: a switch that reloads the document discards the user's typed input, and that is a finding, not a pass.

## 3. Prove the typed value survived

```
reticle_assert({ sessionId, predicate: { kind: "allOf", predicates: [
  { kind: "element", query: { testid: "<the field>", value: "reticle-i18n-4471" } },
  { kind: "element", query: { role: "textbox", name: "<the field's label in the new language>" } },
]}})
```

Query the field by `testid`, because its accessible name is now translated and the `name` you saw in step 1 will miss. **Keep `value` in the query**: without it the predicate collapses to "the field exists", which passes on a field the switch emptied. The second clause proves the label translated with the rest of the page; a form that keeps its values but leaves its labels in the old language is a partial switch.

If the app keeps form state in a registered store, add `{ kind: "state", path: "<form path>", equals: "reticle-i18n-4471" }`. A field that re-rendered empty while the store kept the value, or the reverse, is the desync only the store read finds.

## 4. Reload, and prove the choice stuck

Use a real reload, not a navigate to the URL you are already on:

```
reticle_navigate({ sessionId, reload: true })
```

It must answer `confirmed: true` with a `sessionId`. Assert on that session, which is the reloaded page:

```
reticle_assert({ sessionId: "<sessionId from the reload>", predicate: { kind: "allOf", predicates: [
  { kind: "text", contains: "<heading in the new language>", scope: "h1" },
  { kind: "text", contains: "<heading in the old language>", absent: true },
]}})
```

If the reload is not confirmed, report persistence as **unknown**. `reticle_run({ tool: "reticle_storage", sessionId, args: {} })` shows where the choice lives (a `localStorage` key, a cookie); that is evidence about the mechanism, not a verdict.

Do not reach for `durable: true` on the step 2 call as a shortcut here. It reloads the page the moment the switch verifies, which wipes the form before step 3 can prove it survived. The order matters: switch, then form, then reload.

## What to assert

Only `verified: "yes"` is a pass. `"no"` is a finding, `"unknown"` means Reticle could not tell, and `"no-fault"` means nothing was declared. None of them is evidence the switch works.

1. **Old text gone and new text present**, in at least two regions of the page.
2. **No raw translation key** on screen and **no missing-key error** in the console.
3. **The typed value is intact**, asserted with `value` in the query, and its label is translated.
4. **The reloaded page is still in the new language.**

## Honesty

A verdict here is about one language pair, the strings you named and the one field you typed in. Say which they were. A page with forty strings where you asserted three has thirty-seven unverified strings, so report them as unchecked, not as passing. Right-to-left layout, date and number formats, and pluralisation are separate checks this skill does not make. If a string stayed untranslated, give its `file:line` from `reticle_look({ action: "element", sessionId, ref })`, which is the finding the user actually needs. Switch the language back before handing back, or the next person's session opens in the wrong language and looks like a regression.

---

Capability reference: `curl https://docs.reticle.sh/capabilities.md`. Everything else: `curl https://docs.reticle.sh/llms.txt`.
