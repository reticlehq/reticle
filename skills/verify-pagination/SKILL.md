---
name: verify-pagination
description: 'Prove the next page of a list, or the next batch of an infinite scroll, loads NEW rows from the server, repeats none, and that the end of the list is handled. Use when pagination or infinite scroll was added or changed, when a list shows the same rows twice or skips some, or when the last page still offers a next control.'
license: Apache-2.0
metadata:
  version: 3.6.0
  homepage: https://www.reticle.sh
  repository: https://github.com/reticlehq/reticle
---

# The second page is where lists break

A list that renders its first page proves the first request works. The second page is where the offset is off by one, the cursor is reused, the same rows come back, or the append replaces what was there. The last page is where the "Next" button still fires a request for rows that do not exist.

**Reticle** can check all of that in the running app, against the requests the page really made. Not installed? `RETICLE_INSTALL_SOURCE=npx_skill npx @reticlehq/server@latest init`, then the [`install-and-verify`](https://github.com/reticlehq/reticle/blob/main/skills/install-and-verify/SKILL.md) skill.

## Confirm the session can observe

```
reticle_session({ action: "list" })
```

A hidden or throttled tab can accept a click and render nothing, and an infinite scroll that loads on an intersection observer may never fire at all. If the session is not healthy, get a context that is, for example a leased tab (`reticle_run({ tool: "reticle_lease", args: { action: "acquire", url } })`). Otherwise report the run as **blocked**, not passed.

## 1. Record the first page

Write down what is on screen before you touch anything, or you have nothing to compare the next page against:

```
reticle_look({ action: "find", sessionId, by: "role", value: "row" })
```

Use whatever the rows really are (`row`, `listitem`, `article`, or a `testid`). Keep the visible text of **every** row, not a sample: a repeat from the middle of page 1 is as much a bug as one from the top. If the result says it was truncated, scope the find to the list (`scope: "<the list's ref>"`) until it is not, or say which rows you could not see.

## 2. Load the next page, and name the consequence first

Name what must happen before the click, not after. For **numbered or next/previous pagination**, the page is replaced, so the first page's rows must be gone once the new request has answered:

```
reticle_act_and_wait({ sessionId, ref: "<next control>", action: "click", until: { kind: "allOf", predicates: [
  { kind: "net", urlContains: "/api/items", ok: true },
  { kind: "text", contains: "<first row of page 1>", absent: true },
  { kind: "text", contains: "<last row of page 1>", absent: true },
]}})
```

For **"Load more" or infinite scroll**, the page is appended, so the first page must still be there and the request must have answered. Use the action that really triggers the load: `click` for a "Load more" button, `scrollIntoView` on the list's end for a list that loads when scrolled.

```
reticle_act_and_wait({ sessionId, ref: "<load more button>", action: "click", until: { kind: "allOf", predicates: [
  { kind: "net", urlContains: "/api/items", ok: true },
  { kind: "text", contains: "<first row of page 1>" },
]}})
```

If the list pages **on the client** (all rows arrive in one response and the page only slices them), no request fires, and a `net` clause would wait for one that never comes. Drop it, keep the text clauses, and say in your report that the server's paging was not exercised.

`urlContains` must name the list's own endpoint. A predicate that any request satisfies proves nothing about this list.

## 3. Prove the rows are new, and none repeat

Read the rows again:

```
reticle_look({ action: "find", sessionId, by: "role", value: "row" })
```

Compare the text with what you recorded in step 1:

- **Paged**: no row of page 2 may be any row of page 1. An overlap anywhere in the list means the offset or cursor did not move.
- **Appended**: every page-1 row appears once, and the new ones follow them. A page-1 row that now appears twice means the batch was appended twice or re-fetched.

That comparison is evidence you read, so turn the result into a verdict. Take one row that is only on the new page and assert it:

```
reticle_assert({ sessionId, predicate: { kind: "text", contains: "<a row only on the new page>" } })
```

If the lists overlap, you have found the bug. Report which rows repeated, and do not report a pass.

## 4. Prove the end of the list is handled

Go to the last page (or scroll until the list stops growing) and prove the control is off:

```
reticle_assert({ sessionId, predicate: { kind: "anyOf", predicates: [
  { kind: "element", query: { role: "button", name: "Next" }, state: "disabled" },
  { kind: "element", query: { role: "button", name: "Next" }, absent: true },
]}})
```

For an infinite scroll, scroll to the end once more, then let the page go quiet before you claim it asked for nothing. An observer that fires after a delay would otherwise land after a zero reading had already passed:

```
reticle_act({ sessionId, ref: "<the list end>", action: "scrollIntoView" })
reticle_assert({ sessionId, timeout_ms: 5000, predicate: { kind: "allOf", predicates: [
  { kind: "settled", quietMs: 1500 },
  { kind: "net", urlContains: "/api/items", count: 0 },
]}})
```

A list that keeps requesting pages past the end is a real finding even when nothing new renders.

## Honesty

Only `verified: "yes"` is a pass. For a client-side list, a `yes` covers the rows you asserted and nothing about the server: say so. Say which endpoint you asserted on, and report any step you could not reach as **unknown**, not passed.

---

Capability reference: `curl https://docs.reticle.sh/capabilities.md`. Everything else: `curl https://docs.reticle.sh/llms.txt`.
