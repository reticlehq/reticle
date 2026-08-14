# Changelog

All notable changes to the **`@reticlehq/*`** packages are documented here (each entry notes the package it affects). The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

**It tells the truth about what it saw.** 2.7.0 was about getting connected. This one is about the two ways a verdict can lie once you are — by claiming something it did not observe, and by refusing to claim something it did. Every item below was found by driving Reticle against a running app rather than by a failing test, which is the honest description of how much a green gate is worth here.

### A verdict must not be decided by where we stopped looking

- **`@reticlehq/server` — a correct app was told it had ignored a write.** `response-ignored` reports that a write succeeded on the server and nothing on the client moved. It is a real finding — a lost write, a response parsed into the void, a render that never happened — and it is also an accusation. But the app's re-render runs a task or two _after_ the response resolves, so a window that ends in that gap sees a successful write and no movement, and reports `verified: "no"` about an application that did everything right. For a verification tool this is the more damaging direction of error: a false green is a missed catch, but a false accusation sends someone to fix code that is not broken, and it is how the instrument stops being believed. The response is no longer the end of the window — the app's reaction to it is. Scoped so nothing else pays for it: a read that changed nothing is a prefetch, a failed write is a different finding, and an action that already moved the UI waits for nothing at all. Deliberately brief, so an app that genuinely drops a response is still reported.

- **`@reticlehq/server` — an action that succeeded came back as a shrug.** A login that plainly worked — the declared signal fired with matching data, application state moved from anonymous to authenticated, the auth token written, capture integrity clean, and our own strongest evidence grade — returned `verified: "unknown"` because one request had not come back yet at the instant of measurement. Optimistic navigation is normal, correct application behaviour, and it is the norm on exactly the flows agents verify most: login, submit, save. The tool had seconds of the caller's own timeout left and returned in under half of one of them, then asked the caller to re-check. It now spends that budget waiting for the requests it started, and only then decides. Nothing was loosened to achieve this: at the moment it used to answer, nobody could know whether the request would succeed, and inventing a green there is the exact defect this product exists to prevent. Waiting also makes the false-green guard **stronger**, because a failure that used to land after the window closed now lands inside it, where it is caught.

### It must not act on the wrong thing

- **`@reticlehq/browser` — a ref reused after a full navigation clicked a different element and reported success.** Element refs are minted per document. Reusing one after a client-side route change was already refused by name; a reload or a cross-page link tore the SDK down and the next document started numbering from the beginning again, so a ref from the previous page was a valid, resolvable, **different** element on the new one. Nothing refused, the wrong element was acted on, and the result came back `ok`. Refs keep their format — every agent passes them back verbatim and saved flows on disk already hold them — and the numbering simply never restarts, so the stale ref misses and the existing refusal fires unchanged.

### A token saving you can actually spend

- **`@reticlehq/server` — `reticle_snapshot { diff: true }` returned changes you could not act on.** The delta cut the tokens it promised, and then every line came back without its ref. Acting needs a ref, so the full snapshot had to be taken anyway: the diff call cost tokens and bought nothing, and the honest advice was "do not use `diff` if you intend to act" — which is most of the time. The delta now carries refs. It also stops reporting focus moving as a structural change: focus is a property of a line, not a line arriving or leaving, so it moved to its own `focusChanged` field and no longer fills `added`/`removed` with pairs of the same element. Duplicate labels are resolvable for the first time — a dozen identical row buttons share one identity, so the diff names which one left instead of an arbitrary one.

### The install tells you whether it worked

- **`@reticlehq/server` — `reticle init` ends on a command that confirms, not a question that dead-ends.** The install has two halves, and writing the files is only the first: nothing is finished until an app carrying the SDK has actually reached the daemon. `init` used to close by asking the agent to list sessions, whose failure is a dead end — the answer is "no sessions" and neither side knows why. It now names `npx @reticlehq/server status`, which answers that question instead: it reports the session, or says which step is outstanding and how to finish it. Then it hands off — once a session appears, ask the agent to drive a flow. `status` needs no MCP reload, so it works in the terminal you are already in.

## [2.7.0] — 2026-08-13

**It connects.** 2.6.0 made verdicts honest. This release is about everything that happens _before_ the first tool call — because the field says most people never get there. The install has two halves: register the MCP server so the agent has the tools, and get the SDK into a running page so there is something for those tools to look at. Almost everyone finishes the first. The second is where the users go, and on the platform most of them are on, the documented default could not connect at all.

So this is a bug-fix release with one theme: an app that is installed should end up running, an agent that asks a question should get an answer it can act on, and a daemon that wedges should always be recoverable without a human. No breaking changes.

### The app can actually connect

- **`@reticlehq/server` — `localhost` is a name with two answers, and Windows tries the other one first.** The daemon binds IPv4 loopback, deliberately, because Reticle must never be reachable off-host. The SDK's default bridge URL says `localhost`. Chrome on Windows resolves that to `::1` **before** `127.0.0.1` — so the documented default configuration cannot connect on that platform's default browser, and the failure reads "could not reach the bridge … is the Reticle daemon running on that port?" while the daemon is demonstrably running on that port. Every remedy that message offered (container, devcontainer, WSL) is wrong for a plain Windows user, so the reader never saw themselves in it. The daemon now also serves IPv6 loopback. Fixed daemon-side on purpose: changing the SDK default would only help apps that reinstall, while aliasing the other address repairs installs that already exist, on their next daemon start, with no app change. Best-effort — IPv6 disabled, or something already holding that address, leaves the daemon exactly as it was — and skipped entirely when `RETICLE_HOST` is set, since that is a deliberate choice about reachability.

- **`@reticlehq/server` — an empty session list is a diagnosable state, not a settled fact.** `reticle_sessions` is the first tool an agent reaches for, and for the largest group of users it is also the last one they call: it returned a bare `{"sessions":[]}`, which reads as a finished answer. An agent cannot tell that apart from a daemon that is down, an app carrying no SDK, or a tab that was closed — so it stops, falls back to reading source, and hands the verification back to the human. The daemon already knew which case it was; that diagnosis was wired only to the ERROR path, so you learned the reason only if you first called a tool that failed for want of a session. The tool that exists to ask the question was the one tool that could not answer it. `why` now comes back with an empty list, declared in the output schema so a strict client does not strip it.

- **`@reticlehq/server` — the non-localhost gate is named where its victims land.** The SDK refuses to dial from a page that is not on localhost unless `allowNonLocalhost` is set. That is correct, and it is invisible: the refusal happens page-side, so the daemon sees silence and `doctor` reports a perfectly healthy daemon while every checklist item passes. On a hosts-file alias — the ordinary setup for white-label and multi-tenant apps — that is a guaranteed no-connect that appeared in nothing we ship. It is now part of the no-session diagnosis.

- **`@reticlehq/server` — Nuxt gets a recipe that can work, instead of React and a guard that cannot fire.** Nuxt has no `vite.config` to patch and serves no `index.html` to inject into, so it fell through to `html` — and was then handed `@reticlehq/react`, a package with `react` in its peer dependencies, for a Vue codebase. It was also handed a snippet guarded on `window.location.hostname === 'localhost'`, which fails twice over in Nuxt: `window` does not exist during SSR, and on any dev host that is not literally localhost the guard is false, so the connect never runs — no error, no console line, no session, nothing to debug. Nuxt is now detected in its own right, installs the framework-neutral sensor, and gets a dev-only `.client.ts` plugin guarded on `import.meta.dev` (build-time, so it does not care what hostname you develop on), with the dev-server restart and `allowNonLocalhost` both said out loud. Marked UNVERIFIED, because there is no Nuxt app in CI here and an auto-written plugin would be a support claim nothing backs. Closes [#76](https://github.com/reticlehq/reticle/issues/76).

- **`@reticlehq/vite-plugin` — the documented install red-built any project that typechecks its own config.** `reticle()` in a plugin array failed `vue-tsc --noEmit` with TS2322. The cause is contravariance, and it is the opposite of what the loose types look like they are doing: declaring `invalidateModule: (mod: object) => void` as a **property** makes its parameter checked strictly, so widening it to `object` makes the type harder to satisfy and Vite's real server stops being assignable. Method syntax is checked bivariantly, which is the latitude a structural stand-in wants. The plugin always WORKED at runtime, so no fixture and no gate here could see it — only a user who typechecks in CI, whose only ways out were a cast the docs never mention or excluding their config. Pinned with a compile-time test against Vite's own types.

### A drive that ran should produce a verdict

- **`@reticlehq/server` — a near-miss predicate cost the whole verdict, not just the check.** Predicate rejections are the largest named class of tool error after "no session", and every one lands on `act_and_wait` / `wait_for` / `assert` — the only tools that produce a verdict at all. A rejected predicate does not merely fail: **nothing runs**, so the drive ends with no result, and the agent retries blind or reports the change unverified. The shapes agents write are not careless; they are the spelling the neighbouring kind uses — `text` on a predicate whose kind is called "text", `value` from the element query's own field, a flat `role`/`text` pair copied from the `reticle_query` call that just located the element. Those are now accepted (an explicit `query` always wins, so nothing is reinterpreted against its author's intent), and a rejection names the fields **that kind** accepts, read off the schema so it cannot go stale — which covers the near-misses nobody has made yet.

### The way out is always available

- **`@reticlehq/server` — a proxy that gave up could never find a daemon that arrived later.** The worst failure this product has, and it lands at minute two of a first-ever setup: the daemon came up wedged, the proxy spent its reconnect budget against it, and every call from then on returned `-32001` — including after the human killed the wedged process and started a healthy daemon on the same port by hand. The only remaining fix was reloading the MCP server in the editor, which no agent can do for itself, so the session ended with a live browser tab the agent could not reach. A wedged port accepts the socket and serves nothing, so the in-flight reconnect never resolved **or** rejected and the proxy stayed convinced one was coming; every later request queued behind it, expired, and was answered with a failure. Expiring the queue is exactly the proof that reconnect is not coming, so the proxy now goes dormant there and the next request re-probes the port.

- **`@reticlehq/server` — `reticle stop` gave up precisely when it was needed.** It sent SIGTERM, waited, then reported a timeout and exited, leaving the process alive, the port held and the pid file stale. A daemon that ignores SIGTERM is wedged — the one situation `stop` exists for. It now escalates to SIGKILL after the graceful window, and only reports failure if the process survives that too, naming the pid so a human can act on it.

### It said things that were not true

- **`@reticlehq/server` — the version-skew remedy names a command we actually ship.** _(`reticle doctor`)_

- **`@reticlehq/server` — a Chromium hint you could not satisfy by following it.** `doctor` said Chromium was missing; the user ran the suggested command; it succeeded; `doctor` still said missing. `npx playwright install chromium` resolves the LATEST playwright, which pins a different browser revision than the one the daemon bundles — so the advice downloads a build the daemon will never look at. One report came from a machine that already had five chromium builds on disk, none of them the wanted one, with no way to learn which one was wanted. The command is now pinned to the playwright doing the asking, and the line names the path it probed, which is what turns "missing" from a verdict into evidence. A missing playwright is reported as its own case. One builder shared by `doctor`, the pool launcher and the recovery hint, so the three cannot disagree.

- **`@reticlehq/server` — `reticle open` claimed a launch it never checked.** It reported "the browser was launched", offered "the app may still be loading" and "it is not wired to this bridge" as equally weighted causes, and pointed at `reticle doctor`. It asks the OS to open a URL and cannot see whether a window appeared — and the Chromium check it sent readers to is about a browser this command never uses, so a missing Chromium read as the explanation for an unrelated missing session. Two separate reports followed that trail into auditing app wiring that was never at fault; one concluded, correctly, that `connected:false` from `open` should not be believed. It now says what it actually did, leads with the cause that is overwhelmingly the real one, and names the console line the SDK writes when it refuses a non-localhost connect.

### We can finally see the funnel

- **`@reticlehq/core`, `@reticlehq/server` — `app_instrumented`: the install's second half, which nothing could measure.** `daemon_started` and `mcp_client_connected` describe the agent half. `session_appConnects` describes the app half but is a **window** counter — it resets on every flush, so a user whose app connected in one window reads zero in every other, and the group it under-counts is exactly the group being measured. A funnel over it reported fewer instrumented users than there were users calling tools, which is impossible on its face. The new event fires once per daemon run, on the first session-ready only, so `daemon_started` → `app_instrumented` is a rate rather than an inference and a reloading page cannot inflate it. It carries whether `init` ran here, whether an agent was already waiting, and how long the daemon sat with nothing wired — and deliberately no stack, since `project_profiled` already reports that for the same run. What it still cannot see is **why** an app never connected; every cause for that is page-side, and closing it needs the SDK to report its own refusals. Documented as the next thing to build rather than left as an unexplained gap.

### The verifier stopped asserting failures it did not observe

- **`@reticlehq/server`, `@reticlehq/core` — a correct action could come back `verified:"no"`.** Reproduced on the bench app: the declared signal fired **with matching data**, application state changed, the token was stored, the capture was clean, and the honesty grade was `signal` — our strongest evidence class. The verdict was still `no`, because one POST had not settled at the instant of measurement while the app navigated optimistically. That is normal application behaviour, and it is overwhelmingly common on the flows agents verify most: login, submit, save. A **timing** observation was overruling a **consequence** observation, which inverts the grade hierarchy the verifier is built on.

  The twelve contradiction kinds are now split by what they are made of. Seven are OBSERVED — a request returned 500 while the UI advanced, a signal fired disagreeing with the DOM, a written field echoed a different value — and they still force `no`, because a green assertion sitting on top of a failed write is the entire bug class Reticle exists to catch. Five are inferred from the ABSENCE of evidence in a window whose end Reticle itself chose (`request-never-settled`, `response-ignored`, `route-rendered-nothing`, `action-had-no-effect`, `duplicate-request`); those now yield `unknown`. The finding is still reported in `contradictions` either way, so nothing is hidden and an agent that wants to wait and re-check has what it needs.

  A false negative is not the mirror of a false positive: it makes an agent redo work that already succeeded, or stop trusting the verdict channel — and the verdict channel is the product. This is the same reasoning that removed `bug.attribution`, where every `attribution:"app"` on `request-never-settled` proved to be a misattribution.

- **`@reticlehq/server` — `--drive` blamed Reticle when the user's app was down.** With the drive URL unreachable, the daemon tore down before it had listened, Node rejected the close with `ERR_SERVER_NOT_RUNNING`, and that rejection replaced the real cause. The message read "Server is not running" — about Reticle. It now reports the actual failure, `net::ERR_CONNECTION_REFUSED at <url>`.

- **`@reticlehq/server` — two instructions that cost agents a wasted call.** `SKILL.md` told agents twice that `act_sequence` must be reached through `reticle_run`; it has been advertised directly since 2.6.0, and the comment promoting it says the reason was that agents did not know it existed and were driving login forms one round trip at a time. And a doc pointer riding in `reticle_act`'s description — re-sent to every agent every turn — named a path that does not resolve in a user's project; `docs` ships in the tarball, so it now points where the file actually is.

### The benchmark runs again, and says the release is good

`bench-all` had been unable to complete since June, so the whole 2.x line shipped with no regression signal. The cause was not the product: fixtures were spawned through a wrapper and killed by the wrapper, so a previous run's dev server was orphaned, held the port, and answered the health check — the battery then drove a process nobody owned, which later died and took every remaining pass with it. Fixtures now lead their own process group, are killed by group, and boot asserts the children we started are still alive rather than trusting an HTTP 200.

Measured on this release, with the verifier change in: selector detection **3/3**, consequence **2/2**, state **1/1**, and network-cardinality, forbidden-call, console-clean and state-blast-radius **all caught**. Verdicts deterministic over 8 runs at **0% flake**. A replay costs ~237 tokens against a 30,249-token Playwright re-drive, and a four-flow suite verifies in ~68 tokens against 120,996.

### The agent reports, fixed

Every one of these came from an agent using `reticle_feedback` while doing something else. They are not wishlist items — each one cost its reporter a verification they could not complete.

- **`@reticlehq/browser` — a drag with no coordinates is a false green we produced ourselves.** `reticle_act { action: "drag" }` returned `ok:true`, `dispatched:true`, `domMutatedWithin:0` on a @dnd-kit board where the card had not moved. Every pointer event was built without `clientX`/`clientY`, so source and target both reported `(0,0)` and a geometry-based collision resolver saw a zero delta. The moves also carried no `buttons`, so the standard `event.buttons === 0` release-guard bailed mid-drag, and there were no intermediate moves, so a `distance` activation constraint never saw the pointer travel. Drags now follow a path from source centre to target centre with the primary button held. **`press` had the matching defect**: it set `key` and never `code`, and dnd-kit's KeyboardSensor, react-aria and anything keyed on physical keys match on `code` — so the keyboard fallback could neither start nor steer a drag either.

- **`@reticlehq/browser`, `@reticlehq/server` — a container with no role, name or testid is reachable again.** Every query excludes its own scope root, so a plain layout element — routinely the one carrying the handler — could not be addressed at all, and "click the empty region of this row" (dismiss, deselect, close, marquee-select) was inexpressible. `reticle_query { scope, self: true }` returns the scope element itself. Getting that to work end to end meant adding it to THREE allowlists — tool schema, server forward, browser command parser — and it was missing from the third, so the first live call returned zero matches on an element plainly on the page, with no error. A test now asserts the forwarded payload.

- **`@reticlehq/server` — a mark id came to mean a different mark.** An agent fixed two human-flagged bugs and closed a third it had never touched, while the two it fixed vanished unrecorded. The review store is created per Session, and a Session is recreated on every reload and reattach, so each new store restarted numbering at `m1` and an id the agent still held began denoting somebody else's mark. Ids now outlive the store that minted them, and `resolve` echoes back the note it retired so a surviving mismatch is detectable rather than silent.

- **`@reticlehq/server` — a human message could vanish between two readers.** The inbox has two consumers (the envelope on every tool result, and the explicit poll) and delivery is destructive, so whichever ran first took the message and the other reported an empty queue with a note reading as "the human has said nothing". The person who typed it got silence with no sign it had been received. Delivered-once stays; forgetting does not — the poll now reports what was already handed over and says plainly that an empty result never means silence.

- **`@reticlehq/server` — a guess no longer outranks a certainty.** The no-session message led with "the dev server is not running — the likeliest cause by far" and mentioned only afterwards that the project had never been through `reticle init`. One is an inference from a narrow port scan; the other is a fact. An agent spent a diagnostic step confirming a dev server that was up because we told them to. The certainty now leads. The scanned set also gained the defaults agents actually meet (Tauri, `vite preview`, second Next/Vite instances, Gradio, Streamlit) — reproduced live during this release, with two dev servers running and neither port scanned. The hedge stays, because any `--port` still makes the list wrong.

- **`@reticlehq/server` — `init` stopped telling Python developers they were in the wrong directory.** "No package.json found here" reads as a path problem, so an agent on a Streamlit app went looking for a directory that does not exist and then for a browser bundle to inject by hand. It now names the ecosystem, explains that the SDK needs a JavaScript build to be imported into and that no directory would change that, and still points at a `frontend/` when one exists.

### Found by driving the product at itself

Three defects in the above, caught only by running a real agent against a real app over MCP after every gate was green. Each was invisible to unit tests by construction, and each is now guarded.

- **`@reticlehq/server` — the readable predicate error never reached the path agents use.** `parsePredicate` exists so a malformed predicate never comes back as a serialized zod array, and it works on the paths that call it. But the MCP SDK validates tool input against the same schema BEFORE the handler runs, and its rejection **is** that array — so on the only three tools that produce a verdict, agents still got `[{"code":"unrecognized_keys",...}]`, naming the fields that failed and not one that would have worked. Every unit test called the handler directly and so never crossed the layer that was broken.

- **`@reticlehq/server` — `attachSessionReady` was a single slot.** The second caller silently replaced the first, so a handler registered before the flow-chip one never ran again. This is what made `app_instrumented` fire into a void: the call was correct, registered first, and overwritten. Now additive, and one handler throwing no longer robs the others of their turn.

- **`@reticlehq/core`, `@reticlehq/server` — a new telemetry block reached the wire through none of its four hand-maintained lists.** Adding one means editing the core wire schema, the event-building spread, the destructure and the prefix map, and nothing keeps them in step. The event fired, validated and arrived carrying only the base envelope. The schema now lives in core with the rest of the contract, and a new test asserts every declared block arrives as `<block>_<field>` properties — it fails when any one of the four is missed. The e2e telemetry spec was separately hand-copying core's session-scoped event list, in the gate that exists to catch telemetry going missing; it imports it now.

### Verification actually completes

- **`@reticlehq/server` — a verdict is unclean only when THIS window lost evidence.** `act_and_wait` decided the capture was dirty by watching the ring buffer's _session-wide_ drop counter move across the call — and two of the buffer's three eviction paths have nothing to do with the window being observed: age retires everything past 60 s on **every push**, and the churn floor is sacrificed on purpose so scarce evidence survives. So on any page that had been open for a minute the flag was close to always-on, and the verdict came back `verified: "unknown" / unclean_capture`. In the field this became a large share of all `unknown` verdicts: Reticle drove the app, saw the whole window intact, and refused to say what it saw. The buffer now tracks the newest non-churn event it has evicted and answers the only honest question: did _this_ window lose anything.

- **`@reticlehq/server` — four guidance channels were spliced onto tool results and declared on none of them.** A schema-strict MCP client validates `structuredContent` against the tool's `outputSchema` and drops what is not declared, so each of these was built, fired, and thrown away before any agent saw it: **`verify_next`** (the verdict nudge — the largest known lever on whether a session produces a verdict at all), **`feedback_invite`**, **`version_skew`**, and **`feedback_undelivered`**. The second time this class has shipped; the envelope shape is now _derived_ from a closed `EnvelopeKey` and a mutation-tested guard reads the splice sites, so the two cannot drift again.

- **`@reticlehq/server` — the rule `reticle init` writes into your project no longer leads the agent to the tool that proves nothing.** 2.6.0 fixed this in `SKILL.md` and the MCP handshake, and the tool mix moved sharply toward the verdict-producing tool as a result. It missed the block written into your own `CLAUDE.md` / `AGENTS.md` / cursor rule, which the agent re-reads every session and which still said "drive the actual flow (`reticle_act` / `reticle_act_and_wait`)". It now leads with `act_and_wait`, names `act_sequence` for multi-step flows, says plainly that `verified: "unknown"` is not a pass, and tells the agent to act on `verify_next`. Same correction in `docs/agent-cheatsheet.md`.

- **`@reticlehq/browser` — a `drag` whose target could not be resolved dragged nowhere and reported success.** `drag` reads its drop target from `args.toRef`, and `toRef` appeared **nowhere** in the tool description an agent reads — the arguments sentence named `value`, `text`, `native`, `holdMs` and `confirmDangerous` and omitted the one argument without which the action cannot do its job. So agents guessed (`target`), the guess read as "no target given", which is a legitimate free drag, and the result came back `ok: true` with a healthy effect block over a drag that had landed nowhere. `toRef` is now documented, `target` is accepted as an alias, and a target that was NAMED and did not resolve is refused instead of silently degrading. The destructive-action guard reads the same resolver, so it can no longer classify a drag by a target the dispatch will not use.

- **`@reticlehq/browser` — `press` sent `Enter` no matter which key you asked for.** The tool description documents `{ text }` for press; the implementation read `args['key']` and defaulted to `'Enter'`. So the documented call — `press` with `{ text: 'Escape' }` — dispatched **Enter**, silently, and reported success. Three things follow, worst last: the requested key never arrived, so Escape-to-close and Tab-traversal went unverified while looking verified; nothing in the result said the argument had been ignored; and **Enter is not a neutral substitute** — on a focused field inside a form it submits it, so a request to dismiss a dialog could file the form behind it. The destructive-action guard read the same missing argument, so it classified the call by a key nobody had asked for either. `text` now wins, `key` still works, and the default applies only when neither is named.

  > This also corrects a diagnosis. Two field reports attributed it to "synthetic events not reaching the app", and a third and fourth report generalised that into a theory about our whole dispatch layer. The events were arriving perfectly and saying the wrong thing — the regression test asserts a `document`-level handler sees the keypress, which it always did.

- **`@reticlehq/browser` — `check` / `uncheck` told no framework anything, and reported success anyway.** They assigned `el.checked` and dispatched a bare `change`. React binds a checkbox's `onChange` to the **click** event, and its value tracker dedups the change it would otherwise synthesise from a direct assignment — so on any controlled `checked={state}` box the handler never ran, the component state never moved, and the action came back `dispatched: true` over a ticked box the app had never heard about. A tool whose purpose is catching false greens was manufacturing one. Both now drive the control with `click()`, the one DOM call that runs the element's activation behaviour as well as firing the event; they stay idempotent (`check` means "end up checked", never "toggle"), report `defaultPrevented` when the app cancels, and **refuse a disabled control out loud** instead of forcing a state no user could reach.

- **`@reticlehq/server` — the manual connect snippet had no pairing token, so the app it wired up could never connect.** The bridge closes the socket with `authentication failed` when a `hello` carries no matching token, and the daemon provisions one on startup — so `reticle.connect({ projectId })`, which is what `init` printed for every stack with no build plugin (plain static HTML, webpack, Parcel, Vue/Svelte CLI, any hand-wired setup), was refused every time. Every other stack already inlined it: Next through `NEXT_PUBLIC_RETICLE_TOKEN`, Vite and SvelteKit through the plugin's `define`, Astro through its config, CRA through a `.env` step built from the same value in the same planner. This path was the one that asked the user to paste the call by hand, and it handed them one that could not work. `init` now inlines the token it has already read, and says what it is for so nobody strips it as noise.

- **`@reticlehq/server` — `init`'s closing line told you to ask your agent something it could not yet answer.** The last thing printed was "Restart `vite`, then ask your agent: List Reticle sessions" — and that question was the one instruction that could not work, because the agent's client read its tool list before Reticle existed and does not re-read it. The user follows the instruction, the agent says "unknown tool", and the obvious conclusion is that the install failed. The reload is now named **first**, with the reason, and omitted entirely under `--no-mcp` where it would be advice about something we deliberately did not do. This is the final line of the primary setup path, so it reaches every user on every route — not only those following `SKILL.md`.

- **`SKILL.md` / `@reticlehq/server` — "installed" now means a flow was verified, and the step that was missing between `init` and the tools is written down.** Two gaps in the paste-URL setup, and they compound. First: `init` registers the MCP server, but a client reads its tool list at startup and never re-reads it — so `reticle_*` is not callable in the session that just ran `init`, however clean the install. Nothing said so, so an agent went straight to driving, got "unknown tool", and diagnosed a broken install. There is now a step that checks, tells the user exactly how to reload (one line, per client), waits, and resumes. Second: nothing defined **done**. `init` exiting 0 means files were written; the tools appearing means the client can reach a daemon; a listed session means the app dialled in — and none of those is evidence that anything works. Setup is now explicitly incomplete until one real flow has been driven and produced a verdict, with the same rule in the block `init` writes into the project.

### The instrument can name its own blind spot

- **`@reticlehq/core` / `@reticlehq/server` — `verification.uncleanLoss` says WHAT was lost.** `unclean_capture` covers three losses with three different owners — our server buffer, our browser transport, and a boundary in the page nobody can see through — and they arrived as one bar. Diagnosing the case above meant reading the eviction policy, because the data could not say which loss it was. Now a closed `CaptureLoss` (`buffer_loss` | `transport_gap` | `blind_spot` | `other`) rides every unclean verdict, and is absent whenever the capture was clean.

### Our own CI was in the production numbers

- **`gate:install` emitted real telemetry, and it was the majority of our own install funnel.** The source-checkout guard silences every harness run from inside this repo — it walks up from `cwd` for the monorepo's `package.json`. The install gate is the one that escapes it **by design**: it scaffolds pristine apps into the OS temp directory and installs Reticle into them from a local Verdaccio, so those daemons are correctly not in a source checkout. Measured in one day of production data: **CI runners supplied 85% of all `init_completed` events and a fifth of all `reticle_installed`, appearing as 19 distinct brand-new users** — one per runner. On a release branch they also report that branch's version, so an unreleased version shows up in production dashboards as though people were installing it. The gate now disables telemetry on its own process before anything spawns, so every child inherits it, and a guard test asserts that it does — per-spawn env is how the next call site would quietly leak.

### Security

- **`@reticlehq/electron` / `reticle-tauri` — desktop captures are written into a private per-process directory (mode `0700`) instead of straight into the shared OS temp directory.** The old filename was guessable by construction — a public constant prefix, a readable pid, and a counter starting at 0 — so on a multi-user machine a screenshot of your app window (customer records, a token on screen, an authenticated session) was readable by any other local user until the sweep removed it, and a symlink pre-placed at that name would be followed by the write. Fixes the CodeQL `js/insecure-temporary-file` alert on `packages/electron/main.cjs`, and the same pattern in the Tauri crate, which CodeQL does not scan. Both writes now also use `O_CREAT|O_EXCL`, which refuses an existing path rather than writing through it. `@reticlehq/server` accepts the new layout **and** the old flat one, so an app on an older shell package keeps getting screenshots against a newer daemon, and removes consumed private capture directories during shutdown so they do not accumulate in the OS temp directory. _(**[DivyamTalwar](https://github.com/DivyamTalwar)**, [#245](https://github.com/reticlehq/reticle/pull/245), closing [#135](https://github.com/reticlehq/reticle/issues/135))_

### Tests that were asleep

- **`@reticlehq/vite-plugin` — a regression guard for the Vite 8 `define` warning.** [#165](https://github.com/reticlehq/reticle/issues/165) was fixed in 2.6.0 with nothing pinning it; this boots a real Vite 8 dev server and fails if the config hook ever returns a key Vite rejects again. _(**[DevChiniwala](https://github.com/DevChiniwala)**, [#241](https://github.com/reticlehq/reticle/pull/241))_
- **`@reticlehq/browser` — two transport specs passed against deleted code.** One asserted a retry loop that had been removed and went green anyway; generalising the check found a second doing the same thing. A spec that cannot fail is not coverage, it is a claim of coverage.

### Backlog

Eight issues fixed in 2.6.0 and never closed have been verified and closed — including two, [#115](https://github.com/reticlehq/reticle/issues/115) and [#112](https://github.com/reticlehq/reticle/issues/112), reproduced live against a stranger holding the port before closing. The open-bug list overstated what was actually broken by roughly a third.

## [2.6.0] — 2026-08-12

**Stop breaking, stop lying, and be able to prove it.** 140+ commits, driven by what the telemetry and the field reports actually said rather than what the backlog assumed. No breaking changes.

### The instrument was wrong about itself

Three defects meant the one number this product is judged by — installs that reach a verification report — could not be computed at all.

- **`@reticlehq/server` — one project produced many project ids.** The fingerprint hashed the raw working directory when there was no git origin, so `reticle init` (run in the app) and the daemon (spawned from wherever the agent's client sat) minted different ids for the same app. The two halves of the funnel could not be joined as a result. Now falls back git origin → repo root → nearest `package.json` → cwd. ([#173](https://github.com/reticlehq/reticle/issues/173))
- **`@reticlehq/server` — the end-of-session event reported nothing.** The periodic flush zeroed the counters while the duration kept running, so `daemon_stopped` described half-hour sessions as containing zero tool calls. Every funnel drawn over it read low.
- **`@reticlehq/server` — a crash whose stack is entirely node internals now reports where it was.** `reticleFrames` keeps only frames inside `@reticlehq/*`, so a system error whose stack is all Node internals arrived with `crash_frames: []` — an error type, a redacted message, and no location. `runtime_crashed` now also carries the failing syscall, the symbolic errno, whether the target was loopback, whether the port was one of Reticle's own (as an enum), and the innermost frame naming Node's own source. The address and port are used to derive those answers and then discarded. _(**[DivyamTalwar](https://github.com/DivyamTalwar)**, [#247](https://github.com/reticlehq/reticle/pull/247), closing [#142](https://github.com/reticlehq/reticle/issues/142))_

  > Worth stating precisely, because two changes in this release meet here: the case that motivated #247 was `connect ECONNREFUSED`, and the change above stops that being counted as a crash at all. So the enrichment does not fire for the refusal it was written for — it fires for every **other** system-error crash, which is where a location was equally missing and where the crash is real. Together they are better than either alone: the non-crash stops inflating the metric, and the crashes that remain finally say where they happened.

- **`@reticlehq/server` — the crash metric only ever reported a non-crash.** Every crash event was one thing: a refused connect to a daemon that had not booted yet, which the proxy is built to tolerate. A real crash would have been invisible underneath it.
- **`@reticlehq/server` — a scheduled idle exit is no longer indistinguishable from an outage.** The large majority of "the agent lost its tools" events were the daemon retiring itself on purpose. ([#168](https://github.com/reticlehq/reticle/issues/168))
- **`@reticlehq/server` — a meaningful share of sessions reported nothing at all.** A daemon killed before its first roll-up (closed laptop, OOM, force-quit editor) emitted no summary, so every usage figure was computed only on the sessions that survived. Sessions now roll up once at 90 seconds, then on the normal interval — non-empty windows only, so idle daemons still cost nothing.
- **`@reticlehq/server` — the stack was undetectable on every project that actually used Reticle.** Detection read exactly one directory, and the daemon's working directory is wherever the agent's client launched — usually the repo root, with the app in `frontend/`. Detection missed essentially every instrumented project as a result. It now reuses `init`'s own app discovery, and reports whether the answer came from the working directory or from a workspace.

### New signals — what the instrument could not see before

- **`appConnects`** — whether an app's SDK ever dialled the daemon. Zero is the finding: it separates a **broken install** from one that works and was never used, which have opposite fixes and were previously the same row.
- **`pendingLost`** — in-flight tool calls a dropped connection actually killed. Almost every "outage" killed nothing and was invisible to the agent.
- **`unknownTools`** — _which_ tool an agent reached for that does not exist. The count said our surface confused someone; the name says which capability they expected. A feature backlog in the users' own words.
- **`clientVersions` and `surface`** — which agent drove the session, on which build, and which tool surface it saw. A single global rate hides everything that matters when your users are different agents.

### It said things that were not true

- **`@reticlehq/server` — a lost connection is no longer reported as a failed assertion.** Reticle claimed the app was broken when it was Reticle that had stopped watching. ([#124](https://github.com/reticlehq/reticle/issues/124))
- **`@reticlehq/server` — a capture that dropped events can no longer grade `proved`.** A window missing 34 events was graded green in a sentence reading "over a clean capture".
- **`@reticlehq/browser` — `reticle_query` reports an identity Reticle can itself match.** Two accessible-name implementations disagreed, which is what made flows record clean and always drift.
- **`@reticlehq/server` — `native:true` no longer downgrades to synthetic in silence**, `confirmed` on navigate reports actual arrival, `interactive` snapshots keep the error the app just rendered, and a failed net assertion names the status it saw.
- **`@reticlehq/browser` — a `blur` action no longer fires React's `onBlur` twice.** `el.blur()` already dispatches a bubbling `focusout`; we dispatched a second one, so a single `onBlur={() => mutate(...)}` ran twice and Reticle reported the double write as a `duplicate-request` contradiction that did not exist in the app. A defect we invented and handed to a human as real — and it made `net.count`, the predicate we advertise for catching double-submits, untrustworthy around any blur-to-save form.
- **`@reticlehq/server` — `init` confirms a file was written before printing its checkmark.** Reported from the field: `[✓] Reticle config → .reticle.json` for a file that was not there.

### It stayed up

- **`@reticlehq/server` — the MCP link survives a daemon that is not there.** A first connect to a missing daemon was an unhandled rejection; browser launches, abort handlers, predicate timers and command timers are all released on shutdown. _(pool and timer leaks fixed by **Dev Chiniwala**)_
- **`@reticlehq/browser` — the SDK backs off instead of retrying every second forever**, and the churn-aware offline queue keeps signal events when it overflows. _(**Dev Chiniwala**)_
- **`@reticlehq/vite-plugin` — Vite 8 no longer rejects our config on every dev boot**, and a dev server started before the daemon stops serving a tokenless connect module forever. ([#165](https://github.com/reticlehq/reticle/issues/165))
- **`@reticlehq/server` — `doctor` names the process holding the port** and flags version skew there; `status` and the daemon log distinguish a killed daemon from a tidy one.

### Errors an agent can act on

- **`@reticlehq/server` — a rejected predicate is a sentence, never a serialized zod array.** These landed on `act_and_wait`, `wait_for` and `assert` — the only three tools that produce a verdict. ([#108](https://github.com/reticlehq/reticle/issues/108))
- **`@reticlehq/server` — `assert`'s `route` predicate accepts `urlContains`**, matching `net`, and every predicate kind is documented.
- **`@reticlehq/server` — a dead `sessionId` names the live ones** instead of sending the agent away, and an unscoped call is refused when two projects are connected. ([#161](https://github.com/reticlehq/reticle/issues/161))

### Verification is now the path of least resistance

The measured problem: **sessions that produced no verdict overwhelmingly never called a verdict-producing tool once.** Verification was not failing — it was not being attempted.

- **`@reticlehq/server` — `reticle_act_sequence` is advertised** (default surface 17 → 18). `reticle_act` dominated the repeat table, and inside those sessions the repeated calls were clicks and fills — a login form driven one round trip at a time. The tool that collapses that was reachable only through `reticle_run`, so an agent had to already know it existed.
- **`@reticlehq/server` — a `verify_next` hint** after three actions with no verdict, naming the two tools that produce one. One-shot per abandoned run, re-armed by a verdict.
- **`@reticlehq/server` — the MCP handshake names the verdict-producing tools.** It advertised "act (`reticle_act`)" — which produces no verdict — and never named `reticle_act_and_wait` at all. It also now says that `verified: "unknown"` is not a pass.

### Added

- **`@reticlehq/server` — `init` registers with every MCP client on the machine**, not just Claude Code and Cursor.
- **`@reticlehq/server` — `args.holdMs`** keeps the pointer down, so hold-to-confirm controls work.
- **`@reticlehq/server` — `reticle_act` reports the text it put on the page**, and `reticle_sessions` reports whether a session stayed attached.
- **`@reticlehq/server` — `flow_verify` records flake outcomes on the parallel path too**, so an agent verifying in parallel finally builds flake evidence. _(**Dev Chiniwala**, [#240](https://github.com/reticlehq/reticle/pull/240))_

### Security

- **electron 34 → 43**, clearing 65 of 81 open advisories; pnpm overrides raised to current advisory floors; Windows argument quoting corrected in `init` (`js/incomplete-sanitization`).

### Thanks

**[Dev Chiniwala](https://github.com/DevChiniwala)** — five fixes, all in the resource-leak and shutdown paths that decide whether the daemon survives a long session. **[Vijay Misal](https://github.com/vjymisal0)** — the lossy-transform guard missed export lists, default and wildcard exports, and type-only exports; the guard's own self-test never tried them. **[BabuBahir](https://github.com/BabuBahir)** ([#236](https://github.com/reticlehq/reticle/pull/236)) — corrected a test-duration figure this repo had been quoting wrongly for months.

## [2.5.0] — 2026-08-09

**One tool surface, an MCP server that stays up, and a long list of answers that were wrong.** Most of it was found by driving the shipped surface against live apps: a hostile-argument fuzz of all 48 tools, a nine-app fixture fleet under a new trace, and stress specs against every transport.

> **Installing in the first ~48 hours?** pnpm's `minimumReleaseAge` refuses packages younger than its window, so a pnpm project will be given the newest ACCEPTED version — 2.4.0 — rather than 2.5.0. `reticle init` detects this, falls back to an unpinned install and says so, and the daemon reports the resulting version skew rather than letting it be silent. To get 2.5.0 immediately: `pnpm config set minimumReleaseAgeExclude "@reticlehq/*"`. npm and yarn are unaffected.

### BREAKING — read before upgrading

- **`reticle init` now exits 1 when a connect step could not be applied automatically.** It used to exit 0 unconditionally. This is correct — an install that needs a manual paste has not finished — but any wrapper that reads a non-zero exit as "the command died" will now misreport it. Our own fixtures harness did exactly that, reporting `init crashed` and abandoning the app before it was ever booted. Read the printed step report rather than the exit code alone; the manual step is named in it.

- **`RETICLE_TOOL_PROFILE` is retired; there is one tool surface.** Every value it ever took still resolves (`full` → the full surface, `core` / `standard` / `hybrid` / `dynamic` → the default). **The replacement for `full` is `RETICLE_ADVERTISE_ALL_TOOLS=1`** plus a daemon restart — the only mode that advertises `outputSchema`, and ~7x the default's per-turn token cost, so it cannot be default.
- **`@reticlehq/browser` — `reticle_act { action: 'select' }` REFUSES a value matching no `<option>` and lists the real ones.** The old "detectable no-op" drove `selectedIndex` to `-1`, still fired `change`, and let a listening app persist the empty value. **If you relied on it, the call throws.**
- **Six parameters that advertised a vocabulary now enforce it at the schema:** `reticle_query.by`, `reticle_scroll_to.by`, `reticle_console.level`, `reticle_session.level`, `reticle_act.action`, `reticle_act_and_wait.action`. Schemas and prose both derive from the enums in `@reticlehq/core`.
- **`@reticlehq/server` — `reticle_state` no longer returns React effect-hook entries;** nothing in them was assertable, and drops are disclosed via the existing `truncation` report.
- **`@reticlehq/server` — `reticle open` reports `connected: true | false` instead of an unconditional `opened`,** names a launcher failure, and counts sessions against the pre-launch count.
- **`@reticlehq/server` — `act_and_wait` with an `element` or `text` consequence that was ALREADY TRUE before the act answers `verified: "unknown"`, not `"yes"`.** DOM-state predicates are evaluated before the act now; event-based predicates are unaffected and pay nothing.
- **`@reticlehq/server` — a detected contradiction outranks an already-true assertion,** which used to win and downgrade a detected false green. **Some verdicts that were `unknown` are now `no`.**
- **`@reticlehq/server` — `reticle_act_and_wait { args: { native: true } }` is refused, not silently ignored:** `args` is a record, so the flag reached nothing and the agent got a synthetic click. Use `reticle_act { args: { native: true } }`, which the refusal names.
- **`@reticlehq/server` — a zero-step flow is refused rather than saved.** `flow_save` used to write a permanent suite entry that can never go green or red.
- **`@reticlehq/server` — `isError` is set on every refusal, not only on a thrown handler.** The flow tools, `annotate`, `project`, `run_export`, both visual tools, `viewport`, `network_mock`, `navigate` and `feedback` all returned protocol SUCCESS with the flag unset. **Anything branching on `isError` will see refusals it did not see before.**
- **`@reticlehq/server` — `reticle_feedback` no longer blocks on the network, and `sent` is narrower.** On the agent path `sent` is false and **`accepted` (validated, redacted, queued) carries the promise**; `sent` still means confirmed delivery. `reticle feedback` typed by a human still waits.
- **`@reticlehq/test` — a suite where every spec skipped no longer reports `ok: true`.** `ok` was `0 === failed`, so **a CI script gating on `summary.ok` went green having verified nothing.** An EMPTY suite stays `ok`.
- **`@reticlehq/core` — the `present` state flag is gone from TOON snapshots** — it was seeded onto every element, so it was true of everything: `[vis,present,en]` → `[vis,en]`. **If you parse snapshot flags, it is gone.**

### Fixed — verifications that could not fail

- **`@reticlehq/server` — a step's `signal` / `net` / `console` assertion is EVALUATED on replay;** an `assert-signal` annotation was written to disk and read by nothing while the flow graded `"asserted"`. **This turns previously-green flows red** — run `reticle verify` and expect real failures.
- **`@reticlehq/server` — a misspelled predicate key is refused instead of weakening the check;** five predicate kinds with all-optional fields left tautologies. `path` / `url` / `data` are now aliases for `pathname` / `urlContains` / `dataMatches`.
- **`@reticlehq/server` — `since` works on `signal`, `route` and `animation` predicates,** not only `net` and `console`, so a scoped assertion is no longer "at any point in the window".
- **`@reticlehq/server` — `flow_verify` on a project with no flows reported `pass`** ("all 0 flows pass"), greening the CI gate for anyone who had not written a flow yet; now `unverifiable`.
- **`@reticlehq/server` — an ordinary React navigation reported as a blank destination:** `route-rendered-nothing` looked only for added/removed nodes and missed a reconcile in place.
- **`@reticlehq/server` — `reticle_annotate` implements `assert-net`, which the docs had been promising** and which returned `annotate_unknown_kind`, leaving the flow presence-only. A new gate fails when an agent-facing doc names a `reticle_*` that is neither a tool nor an event.

### Fixed — correctness and honesty

- **`@reticlehq/server` / `@reticlehq/browser` — `reticle_query` and `reticle_scroll_to` answered "0 matches" for an unsupported strategy instead of refusing,** including `by:'css'`. Fixed at the schema, the browser's strategy switch, and `matchQuery`, which turned ANY exception into "no matches".
- **`@reticlehq/react` / `@reticlehq/browser` — `reticle_state` read the previous commit's hooks, every other commit,** because the DOM node's `__reactFiber$…` key keeps pointing at the mount fiber; fixed in `getFiber()`, so `identify`, `readState`, `hasHoverHandlers` and the CDP reader are all fixed.
- **`@reticlehq/server` — three ways a working capability looked broken:** 22 retired tool names answered "unknown tool" (they redirect by name now); a non-advertised tool called BY NAME got the SDK's bare "not found", scoring 25 false failures in one field sweep; and `reticle_run` answered every failure with "fix the arguments", so a stale ref or a paused session read as the agent's fault.
- **`@reticlehq/server` — a caller's typo could bill them 25k tokens and get blamed on Reticle,** by echoing a 100KB argument back verbatim; `buildErrorPayload` caps every tool error.
- **`@reticlehq/server` — `act_and_wait` on a paused session returned `verified: undefined`** from a call that otherwise looked successful; a pause is the textbook `unknown`.
- **`@reticlehq/server` — every `act_sequence` step compiled to a volatile ref, so every saved flow drifted and could not be healed.** The compiler knew only testids, a first sub-step without one degraded the sequence to the "no anchor" sentinel, and `replayFlow` had no `act_sequence` branch at all — so a saved sequence ran one act with `action: ''` and steps 2..n never executed.
- **`@reticlehq/server` — `annotate` and `record { action: "stop" }` targeted the literal name `default` rather than the running recording,** so annotations hit `annotate_no_step` and an unnamed `stop` lost the recording. `stop` also called a step pinned to a session-scoped ref "may be brittle".
- **`@reticlehq/server` — two verdicts that overstated their evidence:** `verify_change` answered `no` on flows it could not attribute to the change and on suites that were `unverifiable`, and a role+name anchor was unhealable by construction because the role step returned `nearest: null` as a literal.
- **`@reticlehq/server` / `@reticlehq/browser` — a re-rendered control lost its identity twice over:** `reticle_coverage` was keyed by ref, so any framework that replaces nodes reported `exercised: 0` (ref, label or testid all count now), and `anchorOf` set role and name together or not at all, so an icon button reported neither.
- **`@reticlehq/server` — eight reads where "found nothing", "did not work" and "never ran" were the same JSON:** `console` (an empty read carries `observed: true` now), `network`, `animations`, `session { messages }`, `crawl`, `affected` — plus `reticle_clock`, which declared output fields it never returns, so MCP stripped the real ones and both outcomes validated to `{}`.
- **`@reticlehq/server` — an agent's own malformed call is no longer a defect in the user's app:** `until: { kind: 'state' }` with no store returned `no` and emitted `bug_found`; now `unknown`.
- **`@reticlehq/server` — two diagnostics named the wrong cause:** the dev-server probe reported Apple's AirPlay Receiver as the user's app (port 5000 is macOS ControlCenter; it needs a document from `GET /` now, and no longer pins to `127.0.0.1`), and a leaked daemon from another project said "authentication failed" when the token is not wrong, just someone else's.
- **`@reticlehq/server` — `reticle_navigate { reload: true }` dropped the session on 6 of 6 apps;** the id lives in `sessionStorage` now, and an explicit id still wins so a leased tab rejoins its lease.

### Fixed — install and integration

- **`@reticlehq/server` — `reticle init` wrote a syntax error into `next.config.js`,** because the export patterns had no `m` flag, so any config whose export was not the last statement had everything after it swallowed into the wrap while init reported ✓.
- **`@reticlehq/server` — a conditional Next export left the app unable to authenticate,** the pairing token never reaching the client; every top-level export assignment is wrapped now.
- **`@reticlehq/server` — four Astro install defects:** auto-wiring was dead on both real Astro apps (`</body>` decides now, not a file count in `src/layouts/`); the config patch and the connect snippet are atomic, since a snippet with no inlined token cannot connect; a merge into an existing `vite: { … }` produced two `build` keys and silently discarded `target: 'es2022'`; and the SDK is declared to Vite, so `await import('@reticlehq/react')` no longer races a pre-bundle and rejects.
- **`@reticlehq/server` — monorepos outside `apps/` were invisible to `reticle init`,** which ran against the root and wrote into a directory Next never compiles; it reads what the workspace DECLARES now, and **`reticle init --app <dir>`** picks one for callers that cannot change directory.
- **`@reticlehq/server` — Create React App had no working connect path:** `public/index.html` is a static template the bundler never processes, so connect arrives via `src/index.tsx` and the token via `.env.development.local`, and the snippet no longer trips `no-restricted-globals` or uses a top-level `await import` that webpack 5 has off by default.
- **`@reticlehq/server` — a ⚠ on a connect step is not a warning, and `ok` said otherwise;** `ok` was hardcoded `true`, so a run needing a manual step reported success and never dialed the daemon.
- **`@reticlehq/server` — five agent-registration defects:** `mcpRegistered: true` when the step was SKIPPED (`--no-mcp`) or MANUAL; `claude mcp get reticle` answering about a project-scoped entry in an unrelated repo and skipping the global registration; `shell: true` on every exec breaking POSIX paths with spaces (win32-only now); a stale `reticle` entry reported "already registered" forever, so an upgrade could not fix it; and a Cursor config that parses but is not an object (`[]`, `3`, `"x"`, `null`) being destroyed. Cursor is also detected by a project-level `.cursor/` now.
- **`@reticlehq/vite-plugin` / `@reticlehq/next` — the install probes asked the wrong `node_modules`,** resolving `@reticlehq/react` from the PLUGIN's location, which cannot succeed under pnpm: no `sdkVersion` on the HELLO, a build fingerprint pinned to `'unknown'` so Vite's `optimizeDeps` cache never noticed a changed SDK, and the SDK left out of `optimizeDeps` entirely.
- **`@reticlehq/vite-plugin` — a dev server started BEFORE the daemon connects nothing, silently,** because the pairing token is read once at config resolve; the warning fires where it is FROZEN now.
- **`@reticlehq/vite-plugin` — the plugin named a dependency Vite cannot resolve,** by testing NODE resolvability of Vite's nested `a > b > c` form, which under pnpm succeeds exactly where Vite fails.
- **`@reticlehq/server` — `reticle update` updated the daemon and left the SDK behind,** creating the very skew whose message tells you to run it; the app's packages sync first, pinned, then the CLI, and a downgrade is refused.
- **Three more:** a read-only `$HOME` no longer stops Reticle from starting; `@reticlehq/react` source pointers were absolute Windows paths for two thirds of users (the fast gate runs on Windows now); and `prepack` rebuilds `dist` clean, after `tsc -b` left 40 stale files, one load-bearing.

### Reliability

- **`@reticlehq/server` — the MCP server no longer exits when the daemon goes away.** No agent host respawns a stdio server; it is marked DISCONNECTED until a human opens `/mcp`, and the dormant path already answers the handshake locally and wakes a fresh daemon on the next request.
- **`@reticlehq/server` — three more ways the server went down are gone:** an uncaught exception in the proxy (the resilience handler was installed only on the daemon); `reticle mcp` exiting when a foreign process held the bridge port; and `initialize` never being answered against a wedged daemon, because the proxy queued client messages behind an endpoint frame that never arrived.
- **`@reticlehq/server` — a locally-answered handshake left the client connected with NO TOOLS;** the proxy serves the newest `tools/list` it has seen, in-memory and per-process.
- **`@reticlehq/server` — a lost daemon left tool calls hanging until the client's own timeout,** with the MCP server alive; forwarded calls get a `-32001` under their own id (re-sending would click twice) and queued calls expire at 20s.
- **`@reticlehq/server` — a request that arrived with EOF was dropped and called success;** the proxy drains unanswered ids for up to 5s and exits 1 if still owed.
- **`@reticlehq/server` — the daemon idle-exited at 5 minutes and took live runs with it;** with a client attached the grace is 6x the base — 30 minutes by default, set by `RETICLE_IDLE_ATTACHED_MS`.
- **`@reticlehq/server` — a wait that cannot be evaluated is a FAILED wait, not an eternal one;** a throw inside the interval or event listener escaped the awaited chain and the call never returned.
- **`@reticlehq/server` — a leased tab waited 30s for an event some apps never fire, then blamed the app;** Playwright's `page.goto` defaults to `waitUntil: 'load'`, which waits for every subresource.
- **`@reticlehq/server` — `reticle_navigate { reload: true }` no longer strands the agent:** it waits up to 5s for the reconnect and reports `confirmed`, and a displaced session names what displaced it.

### Performance / token cost

- **`@reticlehq/browser` — every agent action waited 450ms to animate a cursor nobody was watching,** 98.5% of all the time the e2e battery spent in the browser. `navigator.webdriver` decides now and an explicit `paceMs` always wins, so a recorded demo still glides: act total **19,657ms → 675ms**.
- **`@reticlehq/server` — `reticle_state` returned ~1,500 tokens of fiber plumbing: 2,632 → 1,333 bytes.** `useMemo`/`useCallback` tuples are deliberately kept — React exposes no hook kinds at this layer, so stripping them would silently delete real state.
- **`@reticlehq/server` — `wait_for` and `act_and_wait` stopped paying a blind poll after settle had closed;** a quiet-window failure reports `retryAfterMs` and the waiter re-checks then. Two in-memory session waits poll at 25ms instead of 100ms, and `reticle_feedback` no longer waits out the network.
- **`@reticlehq/server` — a replay anchor wait ends on the DOM event, not on the tick;** it can only resolve earlier, so a genuinely missing anchor still spends the full settle before it drifts.

### Added

- **`@reticlehq/core` / `@reticlehq/server` — version and contract agreement is reported to the agent.** When the SDK, daemon and MCP server disagree, the next tool result carries `version_skew` naming the pair and the fix. It is a derived contract fingerprint, not version equality, so a patch does not cry wolf, and the agent rule block says what to do with it.
- **`@reticlehq/server` — `reticle init` REFRESHES its managed instruction block,** instead of returning "already wired" and leaving a project on its first release's rule text forever.
- **`@reticlehq/core` — verifications record how the browser got there** (`headless` / `headed` / `attached`), so one number no longer covers CI, a human watching, and somebody's own dev server.
- **`@reticlehq/core` — five session metrics:** `noSessionErrors` (the largest drop-off in the funnel), `consecutiveRepeats` (so a retry loop stops looking like engagement), `abandonedActions`, `tzOffsetMin` and `versionChange.nudged`.

### Changed

- **`@reticlehq/server` — CLI usage errors name the argument that was rejected** (`unknown argument '--bogus'`, `--app needs a value`), not one stderr line of JSON-escaped help naming nothing.
- **`@reticlehq/server` — bare `reticle gate` and `reticle affected` mean the working tree** (`--since HEAD`) — what init's own generated rule tells agents to run, and the parser said "usage:".
- **`@reticlehq/server` — the generated agent files got three fixes:** three commands named a `reticle` binary init never installs (`npx @reticlehq/server …` now, derived from the package's own name); the Cursor rule and both `/reticle` command files are compared by CONTENT, so a Cursor-only project can receive a later rule and somebody else's `/reticle` is left alone; and `--no-mcp` skips all three, and says so.
- **`@reticlehq/vite-plugin` — the dependency-optimizer option key is chosen from the installed Vite's major, read from the APP's root;** Vite 7 deprecated `optimizeDeps.esbuildOptions` and warned on every boot, naming Reticle. Unknown versions keep the older key.
- **`@reticlehq/server` — `reticle doctor` prints the daemon log path and whether tracing is on.**
- **The registered MCP command stays unpinned (`npx @reticlehq/server mcp`), deliberately;** pinning would freeze the agent's server at install version forever, and fixes not reaching people is Reticle's biggest measured problem.

### Observability & telemetry

- **`@reticlehq/server` — the daemon log is finally readable:** every line carries an ISO-8601 wall clock first, so an outage can be placed in time; logs roll at 8MB; the proxy's crash handlers write to a per-port proxy log instead of stderr the editor throws away; and every in-process exit is traced with its code, after which silence narrows to SIGKILL or an OOM abort.
- **`@reticlehq/server` — `RETICLE_TRACE=1` turns the daemon log into a per-stage trace:** one line per stage with its duration, a `callId` grouping a tool call and a `depth` making it a tree, carried in `AsyncLocalStorage`. Off by default, and most of the performance section above came from it.
- **`@reticlehq/server` — losing MCP is now a number.** `mcp_connection_lost` reports the stage, cause and attempt count, capped at two per proxy process so a reconnect storm cannot bill for itself.
- **`@reticlehq/core` / `@reticlehq/server` — `RETICLE_TELEMETRY_FILE` records events locally and sends NOTHING,** same builder and same redaction, one JSON object per line. A release sweep is not a user.
- **`@reticlehq/server` — `bug_found` stopped counting Reticle's own failures,** 34 of 34 in one run: `reticle_run` re-reported defects the inner tool had already reported, and a suite that failed because nothing could RUN is not a regression in the user's app.
- **`@reticlehq/server` — a FAILING verification suite is counted;** `verification_completed` fired only on a pass while `bug_found` fired on the reds, so a red CI verify was invisible. A refused `act_and_wait` is excluded.
- **`@reticlehq/server` — a periodic flush is no longer emitted as `daemon_stopped`;** it is `session_progress`, every 5 minutes rather than 30, and it no longer clears the seen-bug-kinds memory, which had been reporting a repeated defect as new.
- **`@reticlehq/server` — three counters that made the funnel unreadable:** `reticle_installed` never fired at all because the human-command filter sat above it, skipping every machine whose first contact is the agent spawning `reticle mcp`; `reticle mcp` emitted `cli_command_run`, 85% of that event, for something nobody types; and one-shot CLI commands minted a `sessionId`, making any chart counting sessions ~6x high.
- **`@reticlehq/server` — the feedback report is no longer sent on a metric's budget** — 2s, no retry, no persistence, for the only qualitative channel the product has. Now 15s with one retry, and every report is appended to `~/.reticle/feedback-outbox.jsonl` BEFORE the network is touched, so `sent: false` means "queued, not lost". A human's report from a source checkout is no longer silenced.
- **All 15 telemetry event kinds are documented, and a test keeps it that way;** the doc described 7, and the other 8 existed only in the enum — including the MCP-outage metric this release is about.

## [2.4.0] — 2026-08-07

**Setup, and the honesty of the regression suite.** Almost every fix here was found by installing the published build into real applications — a Vite+React admin console, a Preact client with 200 dependencies, Next on both routers, SvelteKit and Astro — and then driving each one over MCP with a live browser tab. Nothing was found by reading the code. Minor rather than patch because it also adds three state adapters, a CLI flag and two connect options. On-disk flow files stay version 1.

### Behaviour changes — read these before upgrading

Two changes alter what an existing caller gets back.

- **`reticle_flow_verify` can now return `status: "unverifiable"`.** A flow with no steps, or one that asserts no observable consequence, used to be counted in `passed` and reported as `pass` — a green that could never go red. Those flows are now listed in a new `unverifiable` array with the reason, `passed` counts only what was actually verified, and the suite cannot claim `pass` while it holds one. **A gate written as `status === 'pass'` will now see a third value**; a gate written as `status !== 'fail'` will silently keep passing empty flows and should be tightened.
- **`reticle drive` shows the browser by default.** It is the command you run when you want to watch, and asking people to opt into seeing their own app was backwards. `serve` / `mcp` are unchanged and stay headless — they own the pool behind leases, flow replay and the spec runner, which are batch. Pass `--headless` to hide `drive`, `--headed` to show the others; `CI` hides `drive` automatically.

### Fixed

- **Next.js connected 0% of the time, for three independent reasons** (`@reticlehq/next`, `@reticlehq/server`).
  1. `withReticle` added a `webpack` key and no `turbopack` key. Next 16 — what `create-next-app@latest` installs — defaults to Turbopack and treats that combination as a hard startup error, so `next dev` **died on boot** for every new Next app. It now configures both bundlers, and Turbopack gets `data-reticle-source` stamping for the first time.
  2. The `reticle-dev.tsx` that `init` generated called `reticle.connect({ projectId })` with no pairing token, so the browser logged `bridge refused the connection: authentication failed` and no session ever appeared. It now reads the `NEXT_PUBLIC_RETICLE_TOKEN` that `withReticle` publishes. The token path existed on both ends and was never joined in the middle.
  3. Next was the only stack still requiring hand edits — wrapping `next.config` and mounting `<ReticleDev />` in the root layout, a JSX edit. `init` now patches both, under the same conservative rules the Vite config gets (recognise the obvious shape, bail to a printed snippet on anything else). A `--src-dir` app also gets the component written next to its layout instead of at `app/`, where the generated relative import pointed at nothing.
- **The FIRST page load after `reticle init` connected nothing, on every Vite app** (`@reticlehq/vite-plugin`). The plugin declared the SDK's transitive CJS dependencies in `optimizeDeps.include` but not `@reticlehq/react` itself, so Vite only learned about it when the injected connect module was requested — mid-flight, during the first load. Vite then pre-bundled it and forced a full reload, and the connect was lost in that reload: no WebSocket, no session, and **no console message**. The second load worked. That is the worst possible shape for this bug: the install looks broken, and it looks fixed the moment anyone refreshes to investigate — which is exactly what "it took an hour to set up" is made of. Reproduced on a real Vite 4 app with a cold dep cache, and only caught because the fixture repo runs against a clean tree where the cache is genuinely cold.
- **The regression suite green-lit a flow that could not fail** (`@reticlehq/server`, `@reticlehq/core`). A flow saved as `{"steps": [], "intent": "navigate to a demo route"}` — which `flow_save` had ALREADY graded assertion-free and `empty: true`, with a warning that it "claims to verify a goal it does not assert" — replayed green, and `reticle_flow_verify` answered `{"status":"pass","total":1,"passed":1,"summary":"all 1 flow pass"}`. The grader had said the flow was worthless and the verdict said everything was fine anyway: a permanent false green in the exact feature sold as the regression suite. A green that cannot go red is no longer counted as a pass — such flows are reported as `unverifiable` with the reason, `passed` stays a count of things actually verified, and the suite cannot claim `pass` while it contains one. A real failure still outranks them.
- **`/reticle` did not exist** (`@reticlehq/server`). SKILL.md told the user "Type `/reticle` anytime to verify the app" in three separate places, and `init` never wrote the file that makes a slash command exist — so the single most obvious way into the product silently did nothing, in every tool, for everyone. `init` now creates `.claude/commands/reticle.md` and `.cursor/commands/reticle.md`, and the command is deliberately scoped to **one flow**: someone installing Reticle has an existing app with dozens of them, and an agent told to "verify the app" spends ten minutes instrumenting everything and producing nothing to look at. It also states that driving needs no `data-testid` — `reticle_snapshot` addresses elements by role and name — because believing otherwise is what turns a two-minute setup into an afternoon.
- **Three calls in `SKILL.md` were invalid as written** — `reticle_snapshot({ maxDepth })` (no such parameter; it is `mode`/`diff`/`scope`), `reticle_act_sequence` called directly (not advertised under the default `hybrid` profile, so it needs `reticle_run`), and the tool counts, given as "~14 core" in one place and "~12 core" in another when the real number is 16. Profile sizes are now measured rather than estimated: `hybrid` 16 tools / ~74k chars, `standard` 33 / ~117k, `full` 46 / ~166k. The docs also now say that `RETICLE_TOOL_PROFILE` is read by the DAEMON at startup — setting it in a client's environment while a daemon is already running changes nothing, which makes two different profiles look identical.
- **`SKILL.md` claimed a gate that does not exist.** "Vite + React, Next.js, Remix, Astro, and plain HTML each have an app in this repo and a CI gate that drives it" — there is no plain-HTML app and no gate for one. The four that are real are now named with the gate that drives each, and hand-wired stacks are stated to have neither.
- **Setup ended at "connected", which is not a result** (`SKILL.md`). A user installed something and watched nothing happen; the payoff was deferred to a `/reticle` that did not exist. Setup now ends by driving one real flow in the visible tab, with the HUD on and a narration line per step, before it reports success.

**The state-truth read was unavailable on every app out of the box** — `hasCapabilities: false`, empty capabilities, and a `reticle_state` holding nothing but `__reticle_renders`, on all six apps measured. SKILL.md calls registering a store "the highest-value line"; `init` wired neither it nor `registerCapabilities`. Three separate defects sat behind that:

- **Nothing generated the calls** (`@reticlehq/server`, `@reticlehq/vite-plugin`). `init` now writes `src/reticle-dev.ts` with `registerCapabilities` populated from a scan of the app's own `data-testid` values, and the `registerStore` line **commented and named for the state library actually found in `package.json`** — TanStack Query first, because a stale cache served as fresh fires no network request, so the network log shows silence and the cache is the only witness. The store line stays commented on purpose: detecting that an app depends on zustand is easy, knowing which module exports the store instance is not, and a wrong import breaks the module everything else hangs off. The Vite plugin imports the file by CONVENTION, so `init` never has to edit the entry file the user owns.
- **Capabilities registered after connect were never announced** (`@reticlehq/browser`). `hasCapabilities` rides in the HELLO, sent at `connect()` — but registering deliberately happens after connect, because `registerStore` needs a live SDK to subscribe through. So an app that declared its entire testable surface still reported having none. The registry now notifies the transport, which re-announces. The hook is on the bare `registerCapabilities` rather than on `reticle.describe`, because the bare function is the documented entry point and wiring only `describe` would have fixed the path almost nobody uses.
- **Re-announcing killed the session** (`@reticlehq/server`). The bridge answered a second HELLO with `hello already received` and closed the socket, so the fix above would have been strictly worse than the bug. A repeat hello on the same socket for the same session is an identity refresh, not a violation; one bearing a _different_ session id still is, and that is the case the guard exists for.

- **Upgrading the SDK in place left the OLD code running in the browser** (`@reticlehq/vite-plugin`). Vite's dep-optimizer cache is keyed on the `optimizeDeps` config and the lockfile — not on the contents of the packages it pre-bundled. Patch the SDK without changing its version (a linked checkout, an overlay, a hand-applied fix) and `node_modules/.vite` keeps serving the stale copy across dev-server restarts. The symptom is the worst kind: the same version in `package.json`, old code in the browser, and **the fix you just shipped appears not to work**. It cost a false negative while verifying the null-fiber crash — the fix was in the tree and the bug was still reproducing until `rm -rf node_modules/.vite`. The plugin now mixes the installed SDK's build fingerprint into the optimizeDeps cache key, so Vite re-bundles when the SDK on disk changes.
- **`reticle_inspect` and `reticle_act` disagreed about the same element** (`@reticlehq/browser`). `describe()` reads the cheap DOM-attribute source because it runs per element on paths that describe hundreds at once; single-element paths are supposed to use `sourceFor()`, which asks the framework adapter first — it knows the component that RENDERED the element, not just the nearest stamped host. `act` did this, `inspect` did not. So on any app whose source comes from the fiber rather than a babel stamp, `inspect` reported `source: null` while `act` on the very same ref returned a path — and `inspect` is the tool an agent reaches for to ask where something lives. Three of six real apps were affected. The code comment in `a11y.ts` had named `inspect` as a `sourceFor()` caller the whole time.
- **An app the agent could see perfectly and could not touch** (`@reticlehq/react`). React writes `_debugSource: null` on fibers it has no JSX source for, but the fiber type declared it `?: DebugSource` — "absent or a DebugSource" — so the `!== undefined` guard let the null straight through to `fiber._debugSource.fileName` and threw `Cannot read properties of null (reading 'fileName')`. `identify()` is on the ACT path as well as the inspect path, so ONE null fiber anywhere in the walk took out `reticle_act`, `reticle_act_and_wait` and `reticle_inspect` for the entire app, on every ref. The read-only tools — snapshot, query, assert, network, console, state — were unaffected, which is what made it look like a per-element problem rather than a dead capability. The throw also pre-empted the React 19 attribute fallback immediately below it, which would have produced the source anyway. Found by driving six real apps over MCP stdio: two of the six could be observed and not driven. The type now says `DebugSource | null` (and `columnNumber?: number | null`), so the compiler catches the next one.
- **Installing Reticle stopped a Pages Router app booting at all** (`@reticlehq/server`) — the worst outcome an installer can have, and it happened TWICE in the same generated file. First, one hardcoded path got two things wrong at once. It wrote `pages/reticle-dev.tsx`, and (a) **every file under `pages/` is a route**, so the app gained a route with no default export — `/reticle-dev` 500s and `next build` fails; (b) a `.tsx` file in a JavaScript project makes Next auto-install TypeScript on the next `next dev`, which on Next 13 takes its `require-hook` down with it so the dev server never starts. The component now goes to `components/reticle-dev.<ext>` (outside the route directory, `src/`-aware) with the extension matching the project's language, and `pages/_app` imports it from where it actually landed. App Router is unchanged — `app/` routes on filename, so a sibling there is inert. Then the fix for it shipped a **regression**: the extension was corrected while the BODY still carried a TypeScript cast (`(globalThis as Record<string, unknown>)`), which SWC cannot parse in a `.jsx` file, so every route served 500 again. The project root is now a `connect()` option rather than a global the generated code assigns, which keeps that file plain JavaScript — and a test asserts the generated body contains no TypeScript-only syntax at all, because catching this by eye failed twice.
- **Astro reported absolute source paths** (`@reticlehq/server`) — its printed recipe defined the pairing token but not the project root, so it was the one framework still emitting `/Users/you/...` where the others emit `src/Counter.tsx`.
- **Only Vite apps got a capabilities scaffold** (`@reticlehq/server`). The generated Next component had none, so half the frameworks were back to `hasCapabilities: false` even after `init` learned to write one.
- **A pnpm-installed project with no committed lockfile was treated as npm** (`@reticlehq/server`). `npm i -D` then died on pnpm's symlink layout with `Cannot read properties of null (reading 'matches')` — and left the package present in `node_modules` but absent from `package.json`, so every later run reported the same failure. A setup that cannot be retried into working is worse than one that fails outright. Detection now reads the markers an installed tree leaves behind (`node_modules/.modules.yaml`, `.yarn-state.yml`, `.package-lock.json`); a committed lockfile still wins.
- **`pnpm add` installed 2.2.1 while npm and yarn took 2.3.0** (`@reticlehq/server`) — a stale registry metadata cache, invisible to everyone. A version-skewed SDK against a newer daemon is the `-32000` path: the app connects, the protocol disagrees, and nothing on either side names a version. `init` now pins the SDK to the CLI's own version, which makes the cache irrelevant and a skewed pair impossible to install by accident.
- **`⚠` meant two different things** (`@reticlehq/server`). The UNVERIFIED lines for Preact and SvelteKit are notices — the app is wired and working, it just isn't covered by a CI gate — but they were emitted as manual steps, so "steps left to do" was a number that could never reach zero and a release gate read two regressions that were not regressions. Notices now have their own mark (`ℹ`) and are excluded from the manual count; `⚠` means work left to do and nothing else.
- **The Vite config patch left trailing whitespace** (`@reticlehq/server`) — `[reticle(), ` before a newline, which is exactly what a formatter rewrites, turning a one-line install into a diff against the user's own style. The insert is now spaced to match the line it lands on.
- **`optimizeDeps` named packages the app might not have** (`@reticlehq/vite-plugin`), so a SvelteKit app logged `Failed to resolve dependency: @testing-library/dom, present in optimizeDeps.include` on every boot — a scary line blaming Reticle for a problem that does not exist. Only resolvable entries are declared now.
- **SvelteKit's generated client hook connected with no pairing token** (`@reticlehq/vite-plugin`, `@reticlehq/server`) — the same defect Next.js shipped, in the other hand-written connect. The bridge requires the token even on localhost, and nothing in a browser can read the file it lives in, so `src/hooks.client.ts` called `connect()` with no credential and got `bridge refused the connection: authentication failed`: app boots, no session, one console line nobody was looking for. The Vite plugin now inlines the token as a `__RETICLE_TOKEN__` define, which any hand-written connect in a Vite app can read, and the generated hook uses it. Measured on a real SvelteKit app: no session → connected in 3.0s.
- **Pages Router apps got a component nothing imported** (`@reticlehq/server`). A Pages Router app has no `app/` directory at all, so `init` wrote `app/reticle-dev.tsx` into a directory that does not exist and the mount step had no root layout to find. It now detects `pages/_app.*` and wraps the page component there instead. Found within minutes of the fixture repo existing, which is the entire argument for it.
- **Astro was detected as plain HTML** (`@reticlehq/server`). Astro SSRs its own HTML and does not list `vite` as a direct dependency, so it fell through every branch to the generic HTML advice — which tells you to add a connect to an entry module Astro does not have, or to bundle the SDK with esbuild. Neither works, and `SKILL.md` has offered Astro as a gated framework throughout. It is now its own framework with instructions that match the recipe the repo's own Astro example uses: a page `<script>`, the pairing token inlined through `vite.define`, and `build.target: es2022` (Astro's default down-levels the SDK bundle and dies on a destructuring transform). The wiring is still by hand — auto-patching it means choosing which page or layout to edit, which is not a choice to make silently.
- **`init` at a monorepo root wired the root** (`@reticlehq/server`). With the app in `apps/web`, it detected "no framework", printed the manual HTML instructions, and would have installed the SDK into the root `package.json` — for the most common real-world layout there is. It already walked _up_ the tree for the lockfile; it now walks _down_ into `apps/*` and `packages/*`, wires a single app silently, and lists the candidates rather than guessing when there are several.
- **Detection was stack-blind** (`@reticlehq/server`). It keyed on "vite is in package.json" and never looked at what the app renders with, so a Vue or Preact app got `@reticlehq/react` installed and an all-green report — a support claim nothing backs. The UI library is now detected and a non-React app is marked UNVERIFIED, saying which parts work (DOM, network, console, state) and which do not (component names, `file:line`).
- **The Cursor rule was written into every project** (`@reticlehq/server`) because `~/.cursor` existed on the machine, so Claude Code users found an unexplained `.cursor/rules/reticle.mdc` in their repo. It is a project file now, written only when the repo has a `.cursor/` dir or Cursor is the only agent found. Global MCP registration is unchanged.
- **`SKILL.md` asked five questions before doing anything** — framework, package manager, dev-server port, existing testids, which AI tool — and buried `reticle init` as a blockquote _inside_ step 1, after them. An agent reading it top-to-bottom did the four-step manual path instead of the eight-second automatic one, and the people this is built for do not know the answers to the questions. Setup is now `npx @reticlehq/server init` with nothing asked; the manual sections are explicitly the fallback for lines the report marks `⚠`. The documented `.reticle.json` `framework` value was also `vite-react`, which nothing has ever emitted or consumed.

**The MCP proxy dropped the agent's tools mid-session** (`@reticlehq/server`). `startMcpProxy` called `process.exit(0)` the moment its SSE stream ended, even though the daemon stayed up (`status` reported a live pid throughout). The agent's sixteen `reticle_*` tools simply vanished — no message, no exit code, nothing to correlate — and no agent can restore them; only a human running `/mcp` can. Reported three times in one session, each costing a round-trip and each looking like it might be a symptom of whatever else was being debugged.

- The proxy now reconnects with backoff instead of exiting, and replays the client's `initialize` into the new session — the daemon builds a fresh `McpServer` per connection, so without the replay a reconnected session would reject every subsequent call. The replayed handshake is issued under a reserved id so its response is dropped rather than reaching the client as a duplicate JSON-RPC id.
- Drops, reconnects and give-ups are appended to `~/.reticle/mcp-proxy.log` with a reason. Proxy stderr goes wherever the agent host puts it, which is usually nowhere; this is somewhere an agent can go read.

### Added

**Three more state libraries Reticle can read** (#70, #71, first step of #76)

- **`recoilStore`** (`@reticlehq/browser`) — takes an atom map plus the transaction stream from a small bridge component, because Recoil has no enumerable registry of live atoms and no per-atom subscription outside React. Each atom comes back as `{ status, value, error }` rather than a bare value: calling `getValue()` on a pending async selector **throws the pending promise**, so a bare projection would lose the whole state read over one slow atom.
- **`svelteStore`** (`@reticlehq/browser`) — a Svelte store has no pull side at all, so this reads by subscribing, catching the synchronous first callback the store contract guarantees, and unsubscribing (what `svelte/store`'s own `get()` does). It holds no lasting subscription and needs no teardown, and it **swallows that first callback** on `subscribe` — forwarding it would emit a state change at registration for a change that never happened.
- **`piniaStore`** (`@reticlehq/browser`) — subscribes with `detached: true` and `flush: 'sync'`. Without `detached`, a store registered inside a component goes permanently silent after unmount: still readable, never emitting another diff, which reads exactly like an app that stopped changing.

**Redaction is configurable** (#74)

- `reticle.connect({ redact: { keys, allow } })`. `keys` adds to the rule (a string matches a key name exactly, case-insensitively; a RegExp is tested), `allow` exempts a key from the default rule and loses to `keys`. Additive only — there is no way to replace the default set. Exempting a key the default rule treats as a credential prints a one-time warning naming it.
- Literal `keys` strings **cross the bridge**, so the daemon redacts them on the driven path too, where request bodies are captured raw from the network stack and never pass through the SDK. RegExp entries and `allow` deliberately do not cross; both exclusions fail in the safe direction. See [docs/usage.md](docs/usage.md#extending-the-redaction-rules).
- With no `redact` option the behaviour is exactly what it was, pinned by a test that walks every credential name the rule catches and every false positive it was taught to allow.

**Svelte source mapping** (#75)

- `@reticlehq/vite-plugin` stamps `data-reticle-source` into `.svelte` single-file components, so a SvelteKit verdict finally carries the `file:line` the rest of the product leads with. `svelte` is not a dependency: the compiler is resolved lazily from your app and its absence is a no-op. A React-only build is unaffected, asserted by comparing the plugin's output against Babel run directly.
- `reticle init` now also patches `vite.config` for SvelteKit. It already installed `@reticlehq/vite-plugin` and never wired it in, so the plugin sat in `package.json` doing nothing.

**A guard for the invariant behind three past bugs** (#77)

- `scripts/check-lossy-transforms.mjs` (wired into `pnpm lint`) classifies every export of the read-path modules, so adding one fails the build until somebody says whether it can drop data and how it declares that. Conformance suites drive fixtures guaranteed to lose data. The guard proves itself with `--self-test`. Rule written down in [CONTRIBUTING.md](CONTRIBUTING.md).

### Fixed

- **`reticle_state` said "that key does not exist" when it meant "here are 50 of them"** (`@reticlehq/core`, found by #77's registry). A wrong `path` into a store with more than 50 keys returned a capped `availableKeys` with no marker, which reads as the strongest possible negative signal — when the key was simply number 51. The result now carries `totalKeys` beside the sample.
- **Source pointers contained backslashes on Windows** (`@reticlehq/babel-plugin`). `path.relative` returns the platform separator, so `data-reticle-source` stamped `src\Foo.tsx:42:8` — the headline `file:line`, in a form matching neither the paths every other Reticle surface emits nor the ones an agent greps for. Nothing failed loudly. Both stampers now always emit forward slashes.

**Desktop on Windows was broken in three places, each silently** (#64). All three were found by building and running the Electron and Tauri smoke apps there for the first time.

- **`@reticlehq/core` shipped with no `dist/desktop-contract.cjs`.** The generator's CLI-entry guard compared `import.meta.url` against a hand-concatenated `file://${process.argv[1]}`, which never matches on Windows, so the generator ran as a no-op while `pnpm build` reported success. An Electron main process requires that file at boot, so **every Electron app built on Windows died at launch** with a module-not-found. The test that exists to catch this skipped whenever the output was absent — which cannot tell "nobody has built yet" from "the build produced nothing" — and so passed the whole time.
- **The bridge rejected every Tauri connection on Windows.** Tauri v2 serves `http://tauri.localhost` there rather than the opaque `tauri://localhost` used on macOS/Linux. Core's page-side `isLocalPage` knew that hostname; the bridge's WebSocket handshake check did not, so the app passed its own gate, dialed the bridge, and got 403 every time. The two halves of one rule had drifted. The bridge now applies `isLocalPage`; a lookalike hostname is still rejected.
- **The desktop battery could not run on Windows**, so none of the above was visible: the harness spawned `pnpm` (which is `pnpm.CMD` there), signalled POSIX process groups, looked for a binary without `.exe`, and matched only the macOS/Linux Tauri origin.

With these, `pnpm test:e2e:desktop` passes on Windows: Electron 20/20 and Tauri 14/14 — **including the native WebView2 capture path**, which v2.3.0 shipped as a documented Known Limitation ("compiles and is type-checked … but has never been executed on Windows; treat a green from it as unconfirmed"). It has now been executed: a real PNG of a hidden window, `fullPage` refused rather than downgraded, three concurrent captures, and no temp file left behind.

## [2.3.0] — 2026-08-05

**Desktop release.** Electron and Tauri become supported surfaces with a committed test battery behind them, and CI compiles the Rust for the first time. Plus a feedback channel so an agent can report a bad verdict, telemetry rebuilt around outcomes rather than activity, and a round of false-green fixes. No breaking API changes; on-disk flow files stay version 1.

### Behaviour changes — read these before upgrading

Nine changes alter what an existing caller gets back. Most change RESULTS rather than names, so nothing fails to compile.

- **Unknown tool parameters are REFUSED, not ignored.** A misspelled parameter used to be dropped and answered with a well-formed negative that read as a fact about your app. It now fails with that tool's own valid example.
- **The bridge SAMPLES above its message-rate cap instead of disconnecting.** A burst used to close the socket permanently, leaving the app running and Reticle blind. Excess events are now dropped and reported as a `rate-limited` blind spot, so a verdict over a sampled window says `coverage: partial`. Raise `RETICLE_MAX_MESSAGES_PER_SECOND` for a busy app.
- **`reticle_project` and `reticle_domain` cap their output** at 25 by default, reporting `totalRuns` / `flowsTruncated`.
- **`reticle_network_mock` and `reticle_viewport` return `no-cdp-provider`**, not `no-visual-provider`. Update any gate on the old code.
- **`reticle_network { ok }` now filters.** It was accepted and ignored, so `{ ok: false }` returned calls that had SUCCEEDED.
- **Desktop visual baselines must be re-taken.** Reticle's own presenter panel and annotator button were composited into every desktop capture; they are now excluded.
- **A one-way Electron `ipcRenderer.send` appears in `reticle_network`**, where nothing appeared before. It carries `oneWay: true` and no `ok`/`status`, because the renderer cannot learn the outcome.
- **Every telemetry event was renamed and the per-tool-call event is gone.** Analytics event names only — nothing in the API changed.
- **`SKILL.md` no longer offers Vue, Svelte or SvelteKit, and now offers Astro.** The first three had no app and no CI gate behind them; if you picked one, pick "Plain HTML / vanilla" — the wiring is the same `connect()` call. Astro had an app and a gate all along and was never offered.

### Known limitation

`reticle-tauri`'s **Windows** capture path compiles and is type-checked against the real WebView2 API, but has never been executed on Windows. It ships labelled rather than withheld — treat a green from it as unconfirmed.

### Added

**Desktop — Electron and Tauri** (#64)

- A desktop app connects to the bridge like any other app; one-line setup via `reticle({ desktop: true })` in the Vite plugin.
- `@reticlehq/electron` — the preload and main-process helpers as a real package rather than files bolted onto the SDK.
- `reticle-tauri` — screenshots and headless mode from two lines in `main.rs`, nothing on the JavaScript side.
- **IPC observer:** Electron and Tauri backend calls are no longer a blind spot — they appear in `reticle_network` as `ipc://<channel>`.
- Screenshots on Electron via `installReticleCapture(win)`; `{ fullPage: true }` is honoured where possible and REFUSED where not, never silently downgraded.
- `{ kind: 'net', ok: false }` asserts on the OUTCOME rather than on a status Reticle invented for IPC.
- `reticle doctor` diagnoses desktop misconfiguration — every failure it catches is otherwise silent.
- The desktop string contract is generated, so drift is impossible rather than merely tested, with a fast-gate guard.
- A committed desktop battery (`pnpm test:e2e:desktop`) driving a real Electron main process and a packaged Tauri binary, plus CI jobs that compile the Rust on Linux, Windows (cross-check) and macOS.

**Verification**

- `reticle_verify_change` — "did my change break anything" in one call, instead of four.
- `verified` + `because` — one field to gate on instead of eight to interpret.
- Contradictions arrive WITH the action, not only when asked for.
- The contradiction hunter reports cross-channel disagreement as a finding; `failure-misattributed` catches a 5xx the app blamed on the user.
- Failure acknowledgement no longer depends on reading English.
- `reticle_coverage` — which controls you drove and which you never touched. `reticle_affected` — which saved flows a diff invalidates.
- `reticle_inspect` joins the default tool surface; every tool now advertises a concrete example call.
- `reticle hunt <dir>` — the arithmetic behind the core claim.
- Reticle now sees files your app GENERATES (a CSV export never crosses the network).
- A command timeout now says what to do about it.

**Telemetry and feedback**

- A feedback channel: `reticle_feedback` for agents and `reticle feedback` for humans, so a bad verdict can be reported instead of silently worked around. Agents can request features, not only report failures, and self-report their model. `RETICLE_FEEDBACK=0` switches it off independently of anonymous counters.
- `bug_found` — the number that says whether Reticle WORKS rather than whether it is used, with `falseGreen` defined by presentation rather than by assertion. CI-found bugs are counted too.
- `verification_completed`, `project_profiled`, `runtime_crashed`, `version_changed`, `mcp_client_connected`, `init_completed` — outcomes and funnel, not activity.
- Tool usage is aggregated instead of streamed (~100× fewer events); every event carries a `sessionId`, an actor (human or agent), and a `projectId` hashed from the git origin so one repo counts once.
- Browser-leg latency, tool timing, machine state and connection FAILURES are measured; the in-page half reports its own failures without taking the SDK down.
- Redaction is derived from the input rather than from a list of field names, and error reports carry a fingerprint rather than anything anyone wrote.
- A telemetry CONTRACT enforced by a test, plus `telemetry-events-test` firing every event for real and checking it on the wire.
- `reticle identify` — opt-in, and the only way Reticle ever learns who you are.
- Reticle tells the agent when a new version exists.

**Fixtures and gates**

- `apps/atlas` — a fixture built to be hard rather than to be passed.
- Store adapters are tested against the real libraries instead of fakes of them.
- The SDK reports its rendering engine (`blink` / `gecko` / `webkit`).

### Fixed

**Verdict honesty**

- A structural blind spot no longer destroys the verdict it should merely qualify, and an unrecognised blind-spot kind no longer crashes the verdict path.
- A `202 Accepted` was counted as success, making every asynchronous workflow "verifiable" at the moment nothing had been decided.
- A click that did NOTHING was reported `verified: "yes"`; waiting for the page to settle was waiting for the evidence to disappear.
- `verified` degraded to `unknown` permanently after a single buffer eviction.
- `settled` was a false green on every streaming Suspense boundary.
- `VIRTUALIZED_UNMOUNTED` had a label and nothing ever emitted it.

**Observation**

- A text change was invisible — the most common thing an app does, unobserved.
- Request bodies were unreachable through the documented integration, and an absent body read as "there was none".
- `reticle_network { count: N }` silently meant "at least N"; `{ ok }` was documented but not implemented.
- The streamed-body watcher was gated on a content-type allowlist and threw unhandled rejections where `Response.body` is absent.
- The DOM observer referenced a global `Node` that is not guaranteed to exist; `jotaiStore` did not compile against a real Jotai store.
- A scoped state read no longer contradicts the unscoped one.
- `{ kind: 'route', contains }` matches the whole route, not just the pathname.

**Desktop** (#64)

- Tauri screenshots, headless mode and driving an occluded window all work — three documented "platform limits" that were not.
- Concurrent Electron screenshots all failed, blaming a helper that was installed; a destroyed requester could get a screenshot of a DIFFERENT window; captures could be saved truncated while reporting success; temp files accumulated.
- A missing preload line read as a clean, empty network view. A one-way `ipcRenderer.send` was completely unobserved. Tauri IPC on Windows was recorded as ordinary HTTP.
- The bridge crashed on a desktop webview's opaque Origin, and the SDK refused to start inside a desktop app.
- The Vite desktop injection could fail silently; `reticle doctor` no longer false-alarms on a bundled preload.
- The Electron preload supports multiple subscribers and a real unsubscribe.
- Both desktop demo apps joined the typecheck gate; the Tauri macOS liveness constraint is documented.

**Cost and discoverability**

- An unknown parameter was silently dropped and the reply looked like an ANSWER; a wrong-shaped call is now answered with a correct one.
- `reticle_project` returned the entire run history unbounded — 176 runs, ~5,000 tokens, in one call.
- The predicate field-grammar pointer was re-sent six times per turn; `reticle_observe` echoed the sessionId on every event; `reticle_state`'s example now teaches the cheap read.
- Lean tool descriptions were truncated inside "e.g."; ref lifetime is now stated; recovery hints no longer name tools nobody can call.
- `reticle_annotate` failed with a code and no way forward; `reticle_coverage` undercounted exactly the actions that WORKED.
- The `sessionId` guidance made a working default look unsafe.

**Infrastructure**

- A session the bridge hung up on now explains itself, and `RETICLE_MAX_MESSAGES_PER_SECOND` raises the cap.
- `@reticlehq/core`'s `prepack` did not generate the desktop contract it exports.
- A failed suite could produce a JUnit report CI read as zero tests.
- `@reticlehq/protocol` is gone from the tree.

**Contributed**

- `withFileLock` reclaims a path's chain entry once it settles, guarded by pointer identity so a queued successor is never dropped. Thanks @DevChiniwala. (#63)
- A bridge outage no longer opens a silent hole in the ledger — a full offline queue discarded events without declaring the drop. Thanks @hardikguptaofficialgit. (#66)
- `spawnDaemon` is injectable, and its fd-leak regression guard is no longer a false green. Thanks @DevChiniwala. (#78)
- `redactUrl` no longer rewrites a query string it did not redact. Thanks @DevChiniwala. (#79)
- A failed suite's JUnit output strips XML-illegal control characters. Thanks @DevChiniwala. (#80)
- `registerStore` no longer accepts a store it can never read — `subscribe` without `getState`. Thanks @DevChiniwala. (#82)
- `selectPath` / `capDepth` understand `Date`, `Map` and `Set`. Thanks @DevChiniwala. (#83)

### Security

- **A presigned S3/GCS URL was recorded verbatim.** A presigned URL is a bearer credential, and `X-Amz-Signature`, `X-Amz-Credential` (which carries the access key id) and `X-Goog-Signature` all passed through unredacted into the agent transcript, the session journal and any recorded flow — a file users commit. Now redacted, boundary-anchored so ordinary fields like `signatureVersion` stay visible, and the non-secret parameters an agent needs for context are deliberately preserved. Thanks @DevChiniwala. (#81)

## [2.2.1] — 2026-07-29

Patch release: anonymous, opt-out adoption telemetry — built transparent-first (a complete public policy, a one-line first-run notice, and a persistent `reticle telemetry disable`) — plus two contributed daemon/SDK fixes. No breaking changes; on-disk flow files stay version 1.

### Added

- **Anonymous usage telemetry (opt-out).** The CLI reports adoption events only — `install` (first run), `invoke`, `session_start`/`session_end` (with duration), and per-tool usage — keyed by a locally minted random UUID and a one-way hash of the project path. No code, no PII, no app data: nothing from the app under test ever leaves the machine. Sends are best-effort and non-blocking (a lost metric never touches a verification), quick CLI commands hand the send to a detached child so they exit at full speed, and ingestion is personless (no person profiles are ever created). Disabled automatically under vitest and in the e2e battery, so test runs never count as users. (`@reticlehq/server`, `@reticlehq/core`)
- **`reticle telemetry [status|enable|disable]`.** `status` prints what's on, why, and where the policy lives; `disable` persists a machine-wide opt-out that survives shells and reboots. `RETICLE_TELEMETRY=0` and the cross-tool `DO_NOT_TRACK` convention are honored everywhere and take precedence. The complete disclosure — every field sent and every field that never is — lives at [`docs/telemetry.md`](docs/telemetry.md). (`@reticlehq/server`)

### Fixed

- **`spawnDaemon` no longer leaks a file descriptor or leaves a ghost daemon.** The parent's copy of the log fd is closed after `spawn` duplicates it into the child; a silent spawn failure (`child.pid === undefined`) returns `false` and unlinks the empty pidfile instead of reporting success, so discovery never sees a ghost and the next spawn can't hit `EEXIST`; and a synchronous `openSync`/`spawn` throw cleans up the lock fd + pidfile rather than leaving them behind. Thanks @DevChiniwala. (#58) (`@reticlehq/server`)
- **SDK-internal warnings no longer pollute the agent's `CONSOLE_WARN` stream.** After `installConsole` patches `console.warn` to observe the app, three SDK diagnostics were emitting spurious `CONSOLE_WARN` events into the observation stream, indistinguishable from the app's own warnings. They now call a native `console.warn` captured at module load, so they reach the developer console without entering the agent's event stream. Thanks @DevChiniwala. (#59) (`@reticlehq/browser`)

### Changed

- **The docs no longer claim "no telemetry."** The accurate promise — **no app data ever leaves your machine**, plus anonymous opt-out usage metrics — is now stated where users look (README, usage, enterprise FAQ, architecture) and detailed in [`docs/telemetry.md`](docs/telemetry.md).

## [2.2.0] — 2026-07-26

The causal-evidence release: every verdict now carries _why_, verification becomes part of "done", and the layer stops trusting evidence it doesn't have. Faster on long sessions and big DOMs, and the published packages are brought to OSS-library standard (licensing, packaging, CI security). No breaking changes — schema additions stay back-compatible and on-disk flow files remain version 1.

### Added

- **`reticle init` writes a verification rule into your coding agent's instruction file** (`CLAUDE.md` / `.cursor/rules/reticle.mdc` with `alwaysApply` / `AGENTS.md`), so the agent verifies a feature with Reticle _after building it_ — not only when you remember to ask. Idempotent and rides with the MCP registration. (`@reticlehq/server`)
- **Causal evidence on results:** a bounded causal summary on `reticle_act_and_wait` (net/console/state/storage/route/signals + settle time), a first-divergence capsule on a red result (the attributed chain effect→handlers→requests→state→DOM, with `file:line`), and a ranked deviation report as the default output after a replay. Blind-spot/coverage lines make partial visibility explicit rather than silent. (`@reticlehq/server`, `@reticlehq/browser`)
- **The verify loop:** `reticle affected <files>` maps changed files to the flows that cover them; `reticle gate` exits non-zero unless passing artifacts cover the affected, non-flaky flows — with anti-reward-hacking (a downgraded or deleted assertion on a changed file is a finding, not a silent pass); `reticle watch` reports affected flows on save. (`@reticlehq/server`)

### Security

- **Captured HTTP response/request headers are redacted before they reach the journal or the agent.** On the driven (CDP) path, `Set-Cookie`, `Cookie`, and `Authorization` were written to `.reticle/` in cleartext and streamed into the model's context; credential headers are now redacted by key and every other header value swept for known secret shapes, like request bodies already were. `cookie`/`set-cookie` joined the sensitive-key set (boundary-anchored, so app cookie names like `cookieConsent` stay visible). (`@reticlehq/server`, `@reticlehq/core`)
- **The enterprise license gate fails CLOSED in production.** A release with no resolvable issuer key (a mis-built build where the baked key was never stamped) previously ran every `ee/` feature FREE with no key and no warning; in production it now denies, and `reticle license` reports the build as MISCONFIGURED. Dev/eval still runs free so a contributor is never blocked. (`@reticlehq/server`)
- **Supply-chain / CI hardening:** Dependabot for npm + Actions, all GitHub Actions pinned to commit SHAs, least-privilege workflow tokens, a CodeQL scan, and the publish workflow now runs the full test gate and refuses to publish from any ref but `main` on a manual dispatch.

### Fixed

- **A run of false greens in the verifier's own trust plumbing** — the class the product exists to prevent. An `anyOf` predicate that greened via its presence branch no longer grades its honesty block as `signal`/`net` (a `minGrade` gate could have trusted a green that proved only presence); a flow's per-step signal can no longer be satisfied by an EARLIER flow's signal in a back-to-back suite; and six fields the handlers returned (`warning` on a throttled tab, the human-pause `guidance`, the RED `file:line` `source`, `window_ms`, a flow's `name`, capability `governance`) are no longer silently dropped by validating tool profiles. (`@reticlehq/server`)
- **Serialization / state-selection correctness:** an invalid `Date` in app state no longer crashes the whole state read (degrades to null); a truncated string or dropped object key is now reported instead of read as complete; a typed array serializes to an array, not an index-keyed object; `selectPath` no longer resolves prototype keys (`constructor`/`__proto__`) or non-canonical indices (`items.01`), and bounds its near-miss key list; `matchValue({})` no longer matches everything; and `settled`'s in-flight count is correct when a request id is reused. (`@reticlehq/browser`, `@reticlehq/core`, `@reticlehq/server`)
- **The ring buffer keeps a single event larger than its whole byte budget** instead of pushing then immediately self-evicting it (a waiter could never see it). (`@reticlehq/server`)
- **A second hardening pass closed more false-green and data-loss edges:** a scoped query/snapshot/assert whose scope has unmounted no longer silently widens to the whole page (a `scopeMissing` signal keeps "scope gone" distinct from "element absent", and an absence check is satisfied when the scope itself is the thing that vanished); the durable journal no longer drops an event when a read observes an in-flight append mid-line; parallel `reticle_flow_verify` no longer loses run-history or anti-gaming-baseline writes to a concurrent overwrite; the annotator's own "flag a bug" overlay no longer leaks into snapshots or the DOM/animation event streams; and the browser SDK's transport can no longer throw into the host app's bootstrap (mixed-content `WebSocket`) or reconnect-storm on a terminal `1008` close. (`@reticlehq/browser`, `@reticlehq/server`, `@reticlehq/core`)

### Changed

- **Long sessions and big DOMs are materially cheaper.** `reticle_observe`/`_network`/`_console` no longer re-read and re-parse the whole durable journal on every call once the ring buffer has evicted (a parsed-tail cache — measured ~1.5s CPU + ~300MB/call on a 1-hour session, now O(new events)); `reticle_network`/`_console` default their output to the most-recent 200 (with the total disclosed) so a flooded session can't return a million-token result; `waitForPredicate` skips the extra near-miss DOM scans on interim polls and paces rechecks so an event flood can't saturate the app's main thread; and the ref registry amortizes its eviction instead of a full sweep per mint on a 10k-element page. (`@reticlehq/server`, `@reticlehq/browser`)

### Packaging

- **`@reticlehq/core` is Apache-2.0** end to end (package.json, LICENSE, NOTICE, and the root license overview now agree) — it is the wire contract every embeddable SDK package depends on, so the "Apache-2.0, safe to embed" promise depends on it.
- **`@reticlehq/babel-plugin` is now CommonJS,** so a standard `babel.config.js` can `require()` it on any Node version (it previously threw `ERR_REQUIRE_ESM` on older Node).
- Every published package declares `engines` (`node >=20`); Apache `NOTICE` files now ship in their tarballs; `@reticlehq/server` ships the enterprise license alongside the FSL one; and `@reticlehq/test` gained a README (its npm page was blank).

## [2.1.0] — 2026-07-18

This release turns Reticle's eyes on the parts of a running app a screenshot fundamentally can't see — the **network tab, client-side storage, and web-perf** — and hardens credential redaction across all of it so none of that new visibility leaks a secret into the agent transcript. It also lands a round of verifier-honesty fixes and a performance pass on the event buffer. No breaking changes — every addition is back-compatible and on-disk flow files remain version 1.

### Added

- **Network observation.** The SDK now instruments `fetch` + `XMLHttpRequest` and emits per-request events: HTTP status, content-type, response size, and status text on every call; opt-in request/response **body capture** (dev-only, redacted, per-body capped so a large payload can't evict the behavioral timeline); and **SSE / WebSocket frame capture** for long-lived streams. Surfaced through `reticle_network`, so an agent can assert "the POST returned 201 with the new id" instead of inferring it from the DOM. (`@reticlehq/browser`, `@reticlehq/server`, `@reticlehq/core`)
- **Client storage & cookie observation.** `reticle_storage` reads `localStorage`, `sessionStorage`, and readable cookies (sensitive keys redacted, `httpOnly` cookies noted as unreadable) — the app's real persistence, for verifying "the token survived reload" or "logout cleared the session." (`@reticlehq/browser`, `@reticlehq/server`)
- **Web-perf metrics.** A `PerformanceObserver` reports Largest Contentful Paint, cumulative layout shift, and long tasks into the ring buffer, so an agent can assert "no layout shift on load" or "LCP under 2.5s" — signals a screenshot can't verify. (`@reticlehq/browser`, `@reticlehq/core`)
- **Snapshots pierce open shadow DOM and same-origin iframes,** so web-component and embedded-frame UIs are no longer invisible to `reticle_snapshot`. (`@reticlehq/browser`)
- **The browser ↔ server boundary is enforced at the import level** — a dev-only ESLint rule bans `node:*` imports in the DOM packages and `document`/`window` in the Node packages, so the DDD contract can't silently erode.

### Fixed

- **Credential redaction is hardened across every surface the new observers expose.** URLs redact sensitive query params, path-embedded single-use tokens (`/reset/<token>`), `#access_token=…` fragments (OAuth implicit flow), and `user:pass@host` userinfo; captured bodies redact sensitive keys in JSON, form-encoded, and plain-text shapes, plus high-confidence secret _values_ (JWTs, provider key prefixes) sitting under a benign key, and `Authorization: Bearer …` tokens. The shared sensitive-key set gained `sessionid`/`jwt`/`pwd`/`sid` (anchored, no substring false positives). (`@reticlehq/browser`, `@reticlehq/core`)
- **A reused `XMLHttpRequest` no longer emits duplicate, mislabeled network events** — the completion listener is attached once per instance and reads the request identity at fire time, instead of accumulating a stale closure per `send()`. (`@reticlehq/browser`)
- **Two false-green oracles fixed.** `settled` no longer reports quiet while requests are still in flight, and a `console.info` assertion no longer "verifies" a level the buffer never captured. (`@reticlehq/server`)
- **`reticle` self-update installs `@reticlehq/server`** (the CLI package), not the schema-only `@reticlehq/core`, and an `npx` rollback no longer rolls _forward_. (`@reticlehq/server`, `@reticlehq/core`)
- **The bridge refuses to start on a remote bind with no `allowedOrigins`** instead of exposing itself, and a protocol-version-mismatched `HELLO` gets a clear "upgrade `@reticlehq/browser`" message. (`@reticlehq/server`, `@reticlehq/core`, `@reticlehq/browser`)
- **`heal-verify` replays from the drifted step,** not the whole flow, so a heal proposal is checked against the step that actually moved. (`@reticlehq/server`)
- **`SnapshotCache` is a true LRU** (was FIFO, evicting the hottest entry), scoped state reads select before applying the transport cap, `costHint` counts real UTF-8 bytes (not UTF-16 code units), and the offline transport queue drops the _oldest_ event on overflow so the freshest state survives a reconnect. (`@reticlehq/server`, `@reticlehq/browser`)
- **Web-perf metric semantics corrected:** CLS is a running cumulative sum (not per-shift under a cumulative name), LCP surfaces only a new larger candidate, and every metric carries its own entry timestamp. (`@reticlehq/browser`, `@reticlehq/core`)

### Changed

- **The event buffer is materially faster under DOM/animation floods.** `RingBuffer` eviction advances a head index (amortized O(1)) instead of `shift()`-per-event (O(n)), and byte accounting is threaded from the bridge's parse boundary instead of re-serializing every event. (`@reticlehq/server`)
- **The snapshot walk resolves computed style once per node** instead of repeatedly, cutting the cost of a full-page snapshot on large DOMs. (`@reticlehq/browser`)
- **Predicate re-checks coalesce** — a single in-flight evaluation with a trailing recheck replaces redundant overlapping passes (the worst `wait_for` bottleneck), and the consequence-vs-presence classification is hoisted into `@reticlehq/core` as the single source both graders share. (`@reticlehq/server`, `@reticlehq/core`)
- **Internal hardening & tidy-up:** one shared element resolver across both replay engines, `heal-run` extracted from `flow-tools`, the example apps grouped under `apps/examples/`, a daemon `O_EXCL` spawn-lock that closes the pidfile orphan race (the "CLI can't stop the daemon by port" symptom), and the browser observers brought to full test coverage.

## [2.0.1] — 2026-07-17

A bug-fix release focused on the verifier's honesty (no more silent false negatives), flow ergonomics, and zero-config setup. No breaking changes — every schema addition stays back-compatible and on-disk flow files remain version 1.

### Fixed

- **The event buffer no longer answers a confident "no" after it dropped the evidence.** The ring buffer evicts events on an age/size cap; when it has, `reticle_observe` / `reticle_network` / `reticle_console` now carry a `buffer: { held, dropped, note }` block so a negative result is distinguishable from "the evidence expired" — the difference between an honest verifier and a silent false negative on a long rollout. Omitted entirely when nothing was dropped (an intact buffer stays token-flat). (#27) (`@reticlehq/server`, `@reticlehq/core`)
- **`reticle_domain` no longer reports a fully-tested app as untested.** `FlowStore.load()` with no `projectId` (the CLI/CI/`reticle_domain` caller) now scans the per-project subdirs like `list()` already did, instead of resolving only the flat path — so a project-scoped flow is loaded, not listed-then-silently-dropped (which reported `flowCount: 0` and every declared signal/testid as a gap). (#26) (`@reticlehq/server`)
- **A flow that starts on another page no longer drifts on step 1 with a mystifying "a step no longer matches."** The recorder now captures the journey's `startPath`; on replay, when the tab is on a different route, the decision's next action says "navigate there (`reticle_navigate`), then replay." (#23) (`@reticlehq/browser`, `@reticlehq/core`, `@reticlehq/server`)
- **The "no browser session connected" error names the real cause.** In a multi-repo / multi-agent setup the usual culprit is a port mismatch between the app's SDK and the daemon's `RETICLE_PORT`; the error now says so instead of only pointing at the SDK flag. (`@reticlehq/server`, `@reticlehq/core`)
- **Security hardening (dev-only, same-machine trust):** `VisualStore.baselinePath`/`diffPath` now reject a traversal name like their siblings, and a failed pairing-token auto-provision warns loudly that the bridge is running without auth instead of degrading silently. (`@reticlehq/server`)

### Added

- **Zero-config daemon discovery.** Each live daemon publishes a `~/.reticle/daemon-<port>.json` registry entry; the Vite plugin, absent an explicit port, connects to the daemon serving THIS project's id — no more hand-reconciling a port in the app config and the daemon's `RETICLE_PORT`. Falls back to the default when nothing matches; an explicit port still overrides. (#24) (`@reticlehq/core`, `@reticlehq/server`, `@reticlehq/vite-plugin`)
- **Prune saved flows.** `reticle_flow_delete` removes a renamed/obsolete flow so it stops lingering in the replay list (project-scoped like `reticle_flow_load`; `not_found` on an absent flow, never a silent no-op). (#25) (`@reticlehq/server`)

### Changed

- **The HUD composer is polished.** The multi-line input's default OS scrollbar is replaced with the thin styled one used elsewhere in the panel, content-box sizing no longer causes a height jump on the first keystroke, and the textarea gains an accessible name. (`@reticlehq/browser`)
- **One `bridgeWsUrl()` builder** in `@reticlehq/core` replaces the four hand-built `ws://…/reticle` strings across the SDK, the Vite/Next snippet generators, and the CLI — the wire string can no longer drift. (`@reticlehq/core`, `@reticlehq/browser`, `@reticlehq/server`, `@reticlehq/vite-plugin`)

## [2.0.0] — 2026-07-11

The single-install `@reticlehq/core` umbrella is retired in favour of **audience-scoped packages**. Each package now depends only on what it needs — `@reticlehq/core` sits at the bottom of the graph as the wire contract (constants + zod schemas, `zod` its only dependency), so the dev-only browser SDK never reaches your server and the Node bridge never reaches your bundle. The split is the one breaking change; the migration is a rename with no behaviour change. This release also folds in the security-hardening work from 1.3.x and adds collision-safe multi-app flow storage.

### Breaking Changes

- **The `@reticlehq/core` umbrella is split into scoped packages.** In v1 you installed one package and imported everything from it via `/server`, `/vite`, `/next`, … subpaths. In v2 you install the package for your role:

  | v1 (umbrella subpath)                            | v2 (install this)          |
  | ------------------------------------------------ | -------------------------- |
  | `@reticlehq/core` (the dev SDK + React adapter)  | `@reticlehq/react`         |
  | `@reticlehq/core/vite`                           | `@reticlehq/vite-plugin`   |
  | `@reticlehq/core/next`                           | `@reticlehq/next`          |
  | `@reticlehq/core/babel`                          | `@reticlehq/babel-plugin`  |
  | `@reticlehq/core/test`                           | `@reticlehq/test`          |
  | `@reticlehq/core/eslint`                         | `@reticlehq/eslint-plugin` |
  | `@reticlehq/core/server` (and the `reticle` CLI) | `@reticlehq/server`        |

  `@reticlehq/core` still exists but is now **only the wire contract** shared across browser ↔ bridge ↔ agent. `@reticlehq/protocol` is a thin deprecated alias re-exporting `@reticlehq/core` (pulled in automatically; import from `@reticlehq/core` in new code — the alias is removed in v3).

  **Migrate:**
  1. Replace the single install with the packages for your app: `npm i -D @reticlehq/react @reticlehq/vite-plugin` (or `@reticlehq/next` for Next.js). Your agent runs `@reticlehq/server`.
  2. Update imports: `@reticlehq/core` → `@reticlehq/react` for the SDK; `@reticlehq/core/vite` → `@reticlehq/vite-plugin`; `@reticlehq/core/next` → `@reticlehq/next`; `@reticlehq/core/test` → `@reticlehq/test`.
  3. Update your MCP client config: the `reticle` CLI now ships in `@reticlehq/server`, so the command becomes `npx @reticlehq/server mcp`. Recorded flows, baselines, `.reticle.json`, tool names, and env vars are unchanged.

### Added

- **Per-project flow storage — collision-safe on a shared daemon.** Saved flows live under `.reticle/flows/<projectId>/`, so one daemon can serve many apps at once without their flows colliding or bleeding across projects: a flow recorded against app A can no longer be listed, loaded, or replayed against app B. The HUD's replay list, `reticle_flow_list/load/replay/heal`, and cloud sync are all project-scoped. Legacy flat (untagged) flows keep loading as global until re-recorded. (#22) (`@reticlehq/server`, `@reticlehq/core`)
- **Cloud flow sync.** When logged in to Reticle Cloud (`RETICLE_CLOUD_URL` + `RETICLE_CLOUD_KEY`), a saved flow is mirrored to your team's regression suite — best-effort, so a sync failure never fails the local save. Off by default: nothing leaves the machine unless you opt in. (`@reticlehq/server`)
- **Upgrade-hint contract** for value-triggered cloud prompts — surfaced only when a capability is actually blocked, never as a nag, and silenceable with `RETICLE_NO_UPSELL`. (`@reticlehq/core`)
- **`reticle version`** (also `-v` / `--version`) prints the running build, so you can confirm which `npx`-resolved version is executing. (`@reticlehq/server`)

### Fixed

- **The SDK reconnects the bridge the instant a tab returns to the foreground.** Browsers throttle timers in a backgrounded tab, so after a bridge outage — a `reticle` restart, laptop sleep/wake, a network blip — the panel could sit on "ENDED" until a manual reload. It now self-heals on focus. (`@reticlehq/browser`)
- **The HUD replay-flow list is bounded and page-scoped.** A long list can no longer hide the log and message input, and it shows only flows that can start on the current page instead of every flow the daemon has seen. (#22) (`@reticlehq/browser`)

### Security

- Block DNS-rebinding attacks against the MCP/HTTP control plane. (#12) (`@reticlehq/server`)
- Redact typed secrets from recorded flow files. (#13) (`@reticlehq/browser`)
- Redact credential-bearing query parameters in the network observer. (#14) (`@reticlehq/browser`)
- Neutralize `cmd.exe` argument injection in the Windows browser launcher. (#15) (`@reticlehq/server`)
- Treat a missing WebSocket `Origin` as untrusted unless a pairing token is set. (#16) (`@reticlehq/server`)
- Bake the issuer public key and fail closed on the enterprise gate. (#17) (`@reticlehq/server`)
- Add a production runtime backstop so the dev-only SDK refuses to activate in a production build. (#18) (`@reticlehq/browser`)
- Auto-provision a pairing token so loopback origins must present a secret to connect. (#19) (`@reticlehq/server`)

## [1.3.1] — 2026-07-06

Bug-fix release. No breaking changes; drop-in over 1.3.0.

### Fixed

- **`reticle_sessions` now declares every field it returns** (`adapters`, `hasCapabilities`, `cleanup_suggestion`, `pendingMarks`, `review_suggestion`, and the input/lease fields). A strict MCP client validates tool output against the declared schema, so the previously-undeclared fields could trigger a hard validation error on the client side; they are now part of the contract. (`@reticlehq/server`)
- **The Reticle HUD no longer counts itself as an occluder** in `reticle_inspect` / `reticle_act` hit-tests. The dev-only presenter overlay could produce false-positive `occluded: true` readings for elements it visually covered; hit-testing now skips Reticle's own UI. (`@reticlehq/browser`)

### Changed

- HUD label capitalized to **Reticle** (was lowercase `reticle`). Display-only. (`@reticlehq/browser`)

## [1.3.0] — 2026-06-30

### Rebrand: Iris → Reticle (BREAKING)

The project is renamed from **Iris** to **Reticle**. This is a clean rename — no behavior changes — but every public identifier moves, so existing installs must migrate.

| What | Before | After |
| --- | --- | --- |
| Install | `iris` | `@reticlehq/core` |
| Scoped packages | `iris-*` | `@reticlehq/*` (e.g. `@reticlehq/protocol`, `@reticlehq/react`) |
| Subpath imports | `iris/server`, `/next`, `/babel`, `/vite`, `/eslint`, `/test` | `@reticlehq/core/server`, `…` |
| CLI binary | `iris` | `reticle` (`reticle init`, `reticle mcp`) |
| MCP server name | `iris` | `reticle` (update your `.mcp.json` / client config) |
| MCP tools | `iris_*` (e.g. `iris_observe`, `iris_assert`) | `reticle_*` (`reticle_observe`, `reticle_assert`) |
| Project config | `.iris.json` | `.reticle.json` |
| On-disk artifacts | `.iris/` (flows, runs, baselines, visual) | `.reticle/` |
| Env vars | `IRIS_*` (e.g. `IRIS_PORT`) | `RETICLE_*` (`RETICLE_PORT`) |
| DOM attributes | `data-iris-*` (e.g. `data-iris-source`) | `data-reticle-*` |
| Next.js wrapper | `withIris` | `withReticle` |

**Migrate:**

1. `npm rm iris && npm i -D @reticlehq/core` (swap any direct `iris-*` deps for `@reticlehq/*`).
2. Rename `.iris.json` → `.reticle.json` and the `.iris/` directory → `.reticle/` — recorded flows/baselines carry over unchanged.
3. Update your MCP client config: server key `iris` → `reticle`, command `npx @reticlehq/core mcp`, and any `IRIS_*` env vars → `RETICLE_*`. Agents calling tools by name move from `iris_*` to `reticle_*`.
4. Find/replace `withIris` → `withReticle` and any `iris` imports → `@reticlehq/core`.

## [1.2.0] — 2026-06-27

The multi-agent release. One Chromium now serves many agents at once — a leased browser pool gives each its own isolated context, and project-scoped session identity keeps several apps on one machine from cross-talking. Plus a polish pass: the benchmark suite runs unattended, CI stops going red on dependency advisories it can't control, the daemon-readiness window is tunable, and the docs + README are rewritten to lead with value. Measured: 16 flows across 8 contexts in 5.2s vs 35.4s serial — **6.78× faster**.

### Added

- **BrowserPool — one Chromium, N isolated leased contexts.** A fleet of agents shares one browser instead of launching one each. Leases carry a TTL + heartbeat with a reaper for orphans, `reticle_lease_acquire` waits for the tab to connect, and `reticle_sessions` shows `projectId` + `leased`.
- **Project-scoped session identity** (on by default). Sessions resolve against a stable build-stamped `projectId` (Next / HTML / `.reticle.json`, auto-stamped by the Vite plugin), so concurrent apps never steal each other's session.
- **SvelteKit support in `reticle init`** for projects the Vite plugin can't inject into.
- **Real-Chromium + multi-agent CI suites** — framework-connect tests (Vite/React, Next App Router, Remix, Astro), the browser-pool path, and single-page crash isolation.
- **`RETICLE_DAEMON_READY_TIMEOUT_MS`** — tune how long the MCP proxy waits for the daemon to become ready (default 10s) for slow machines / CI.

### Changed

- **Daemon resilience + per-page fault isolation.** One bad page can't sink the fleet: page faults are isolated, the pool enforces its cap under burst, aborted acquires clean up, and stale daemon pidfiles are reclaimed (no ghost ports).
- **Docs lead with value and read for everyone.** README rewritten — value-upfront hero, a "who you are → what you get" table (vibe coder / engineer / QA / founder), and a "How to use it" walkthrough. New [multi-agent testing guide](docs/multi-agent-testing.md); benchmark images + numbers refreshed; benchmark passes renamed to plain names (observation-cost / agent-loop / replay).
- **The benchmark self-boots.** `pnpm bench` now starts and tears down its own fixtures (demo + api) with env-tunable readiness (`BENCH_*`), so the suite runs unattended.
- **CI hardened against flaky reds.** The security-audit step is non-blocking (a new transitive advisory no longer fails an unrelated PR), the e2e job retries with cleanup, and pre-commit matches CI step order.

### Fixed

- **`@reticlehq/core/next` `withReticle` no longer crashes the host build** (a bundled `__require.resolve`).
- **`reticle init`** detects the monorepo package manager and gives correct guidance for non-Vite/Next apps (CRA / webpack).
- **Clearer edge errors** — an unopenable leased URL says why; the browser warns when the bridge is unreachable on first connect.
- **Skill & docs corrections** for the public integration path (MCP registration, `reticle init` flow, stale-`npx` cache as the main `-32000` cause).

### Removed

- **Unused public exports** — `ObserverType` / `UpdateStatus` (`@reticlehq/protocol`), `buildClock` (`@reticlehq/test`), and the test-only `RETICLE_VITE_PLUGIN_NAME` re-export from `@reticlehq/core/vite`. No real consumers.

## [1.0.0] — 2026-06-22

The 1.0 release. Reticle is stable, documented, and benchmarked end to end: every package is versioned `1.0.0` under the open-core license split, and the same verify loop that wins on a toy app stays the cheapest way to observe a real production dashboard.

The headline is the "lean responses" pass — same observations, fewer tokens. On the cross-tool detection benchmark Reticle's average observation cost drops 959 → 815 tokens with detection unchanged at 1.0 and zero false positives, lifting Verification Efficiency past the best external tool (12.27 vs 10.55) while remaining the only tool that catches every regression. Re-verifying a saved suite costs 47 tokens with no model and 0% flake, up to **2,574× cheaper** than re-driving it with an LLM.

### Added

- **Honest, reproducible benchmarks with a small-app vs real-app story.** A committed benchmark image set (re-run efficiency, the two-apps small-vs-real comparison, the per-tool cost on the real Reticle dashboard, and a capability matrix) rendered from a public source pipeline (`assets/benchmarks` + a shared design system), with the methodology written up in [`docs/benchmarks.md`](docs/benchmarks.md). On a real production dashboard Reticle observes a page for 1,023 tokens vs Chrome DevTools MCP's 1,357 and Playwright MCP's 2,193, and is the only tool that asserts success from the app's own signal.
- **Documentation set** — an [architecture overview](docs/architecture.md), the benchmarks explainer, an expanded [getting-started](docs/getting-started.md), and a Mintlify configuration so the docs publish as a site.
- **Open-source project hygiene** — `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue and pull-request templates, plus contributor / stargazer / forker recognition in the README.

### Changed

- **`reticle_act` collapses a clean action to its consequence** — the effect block now omits fields at their uninformative default (an absent `dispatched`/`targetMatched`/`visible`/`enabled` means `true`; an absent `focusMoved`/`occludedBy` means `null`; an absent `occluded`/`scrolledIntoView`/ `valueChanged`/`defaultPrevented` means `false`), so a successful click returns just `domMutatedWithin` and any real signal still surfaces. No information is lost — absence always means the boring value.
- **MCP tool results serialize as compact JSON by default** — the agent-facing `text` content drops the two-space indentation (the typed `structuredContent` is unchanged), ~40% cheaper on the structured payloads that dominate. Set `RETICLE_ENCODING=pretty` for the previous indented form; `RETICLE_ENCODING=toon` remains the densest tabular encoding.
- **`reticle_act_and_wait` returns a reaction digest, not the full timeline** — `trace` is now `{ window_ms, summary }` (the counts that answer "what did the app do?") plus a `since` cursor; the full per-event timeline is one `reticle_observe { since }` away when the counts aren't enough. On a large DOM the dropped events array was the bulk of the loop cost — a verify loop on a 5,000-row grid falls from ~531 to ~279 tokens with the consequence still asserted from the `row:approved` signal.

### Fixed

- **Multiple apps on one machine no longer collide or orphan the daemon.** Several Next.js / React apps (or browser tabs) can run at once: the `@reticlehq/next` integration now defaults to a unique per-tab session id (`SESSION_AUTO`) instead of a shared constant, so two Next apps never silently evict each other. A bridge/daemon **port collision now fails fast with a clear error** instead of hanging forever and leaving an orphaned process — the `listen()` calls finally handle `EADDRINUSE`.
- **License files now carry a real copyright.** Filled the Apache-2.0 appendix in every SDK package license so no `[yyyy]` / `[name of copyright owner]` placeholders remain.

### Security

- **Daemon mode now enforces the documented auth contract.** `reticle serve` / the MCP daemon previously built its bridge without forwarding the pairing `token`, bind `host`, or origin allow-list, so `RETICLE_TOKEN` / `RETICLE_HOST` / `RETICLE_ALLOWED_ORIGINS` were silently ignored in daemon mode. They are now honored identically to the in-process path. (Residual risk was bounded — the daemon is loopback-pinned — but the advertised control is now actually enforced.)
- **Every security-critical environment variable is a single named constant** (`ReticleEnv` in `@reticlehq/protocol`). A typo in an inline `'RETICLE_TOKEN'` string could previously have disabled auth silently; the names now live in exactly one place.

## [0.9.0] — 2026-06-21

The "verify anywhere, ready for enterprises" release. One command verifies a running app from any pipeline — no MCP, no human — and enterprise features unlock with an offline license.

### Added

- **`reticle verify <url>`** — one-shot, non-MCP verification: drives the preview, replays the saved flows, prints a deterministic verdict, and exits non-zero on fail. The command CI and AI app-builder platforms call without speaking MCP — the same `ReticleVerificationRun` artifact the MCP and HTTP paths produce.
- **Drive a hosted preview** — for a non-localhost URL, Reticle re-invokes the page's `reticle.connect()` (allow-non-localhost + a one-shot pairing token) so a deployed preview pairs to the local bridge with no app redeploy; `reticle verify --storage-state <file>` replays a logged-in session past an auth wall.
- **Enterprise licensing** — `reticle license` shows activation status; offline Ed25519 keys (`RETICLE_LICENSE_KEY`) verify locally with **no phone-home**. Open-core split: Apache-2.0 SDK, FSL server/CLI, Reticle Enterprise License for `ee/` features.
- **Branded id types** — `RunId` is nominal end-to-end, so ids can't be confused with flow names.

### Changed

- **Hardened persistence + HTTP boundary** — atomic run writes, bounded `.reticle/runs` retention, verify-server request/timeout limits, a frozen contract-lock test, and path-traversal guards on read and write.

### Fixed

- Oracle-backed flows now report **high** confidence — the success consequence propagates into the verdict instead of reading as a smoke test.
- A localhost preview connects to the bridge without a token mismatch; hosted-preview origins are allow-listed.

## [0.8.0] — 2026-06-20

The "developers love it" release. 0.7.0 won the agent; 0.8.0 wins the human — the dev who watches the agent work, points at what's wrong, and trusts the green.

### Added

- **Human review marks — "annotate the bug where you see it"** (`packages/browser`, `packages/server`, `packages/protocol`). A dev-only **"Flag a bug"** button rides with the presenter: the human toggles it, clicks the element that looks wrong, types what's wrong, and Reticle drops a numbered pin + emits a `HUMAN_MARK`. The mark carries the element's re-resolvable anchor (the same durable address a recorded flow uses) **and the source `file:line`** — so the agent fixes the exact element and code, not a guess. The agent drains marks with the new **`reticle_review`** tool: each pending mark comes with a ready-to-act `fix` hint (`Open src/Checkout.tsx:42 and fix: <note>. Then reticle_review { resolve: m1 }`), reading never consumes a mark, and `resolve` retires it once fixed. Off the deterministic benchmark path (human-driven) — `pnpm bench` unchanged.
- **First-run readiness + loop intro — `reticle_wait_ready`** (`packages/server`). Call it right after init: it blocks until the app's SDK connects (returns instantly if a session already exists, so zero latency on the happy path and on the benchmark), or times out with a `recovery` hint. Smooths the most common first-5-minutes footgun — the agent's first real call racing the WebSocket connect. Its ready response also carries a one-line **`loop` guide** (look → act → observe → assert → regress, plus the human-flag → `reticle_review` loop), so a fresh agent learns how to drive Reticle on its first call without reading docs. Pure, injected clock/sleep; off the benchmark path.
- **Deterministic visual regression — `reticle_viewport`** (`packages/server`). Pin the driven page to a fixed viewport size (clamped to sane bounds) so a screenshot baseline is reproducible across machines — the last missing piece of CI-stable visual diffing, alongside the already-shipped `reticle_visual_diff` `masks` (neutralize volatile regions) and a frozen clock (`reticle_clock`). Drive-only, additive; off the benchmark path. Provider-driven and tested via a fake page like `reticle_network_mock`.
- **CDP network mock / intercept — `reticle_network_mock`** (`packages/server`). On a driven page (`reticle drive`), stub a request deterministically: return a `500`, force offline (abort), or delay a response — so "verify the app handles a failed payment" is one declared rule, no backend changes. The matcher is pure (first rule whose url-substring + optional method matches wins → fulfill/abort/continue) and the Playwright `page.route` wiring is driven in tests with a fake Page/Route. Needs a driven browser; returns a `recommendation` to `reticle drive` otherwise. Off the agent/benchmark path.
- **`reticle status` shows sessions + health at a glance** (`packages/server`). The daemon exposes a local `GET /status`; `reticle status` now reports each connected tab (url, throttled, stale, pending human marks) and the session count — not just "running: pid". The plan's "no more pkill in a README" daemon DX. Local-only, off the agent/benchmark path.
- **Actionable error recovery** (`packages/server`). Every tool error returned to the agent now carries a `recovery` hint when the failure is recognized — the no-session footgun, multiple/unknown sessions, a throttled tab, a missing baseline/recording, the pairing-token config — so the first 5 minutes never dead-end on "what do I do now?". Conservative: an unrecognized error gets no invented advice.
- **The panel always reflects the agent's real state — `reticle_yield`** (`packages/server`, `packages/browser`, `packages/protocol`). A human watching the browser must never see "live" when the agent has actually stopped. The agent signals its turn boundary with **`reticle_yield({ mode: "waiting" })`** (done responding, will resume on your next message) or **`{ mode: "ask", note }`** (blocked, needs your answer — the question shows on the panel); the session is revived automatically on the agent's next call. Taught as the mandatory last step in the session lease, the loop guide, and the skill — and it's **agent-independent** (Codex / OpenCode / Claude / Hermes). The panel renders each handback distinctly via a PRESENTER `tone`: waiting = calm teal ✋, ask = amber ❓ pulse, **agent crashed/disconnected** = amber ⚠ pulse, a clean end = calm green. When the last agent's MCP connection drops, the daemon ends every session and pushes the "switch to your terminal" notice (verified end-to-end through a SIGKILL-ed agent). Off the benchmark path.
- **Don't lose a panel prompt in the death-race** (`packages/server`, `packages/protocol`). If the human types a message into the panel at the exact moment the agent stops, it would land in a dead inbox; now both the agent-detach and idle paths fold any unread note into the end banner — quoted and labeled `Undelivered (paste into your terminal): "…"` — so the words are surfaced back, not silently dropped.
- **Replay a saved flow from the panel — no agent** (`packages/browser`, `packages/server`, `packages/protocol`). The daemon pushes the saved-flow names to the HUD on connect; the human clicks **▶** on a flow and it re-runs with no agent in the loop — the page animates via the normal replay path and the ✓ / ⚠ drift / ✗ verdict lands in the same activity log they watch the agent in. The dev plays the regression suite directly. Off the benchmark path (a panel-driven control, not a tool).

### Changed

- **Internal cohesion split** (no behavior change): `SessionManager` moved to its own `session-manager.ts`, and the on-disk-artifact constants to `flow-constants.ts`, bringing both parent files back under the 500-line cap. All public import paths unchanged (re-exported).

### Fixed

- **Panel composer is now multi-line** (`packages/browser`). The HUD message box was a single-line `<input>` that sent on any Enter; it's a `<textarea>` now — **Enter sends, Shift+Enter inserts a newline**, and it auto-grows to fit.
- **Flag mode keeps the right cursors** (`packages/browser`). In "Flag a bug" mode every element showed the crosshair, including the Flag button and its popover — which are clickable; they keep the pointer cursor now. And the hover outline that boxes the element under the cursor no longer snaps jumpily: it **waits for the cursor to rest (~130 ms), then glides into place on an ease** and fades in.

## [0.7.0] — 2026-06-20

The regression-testing release. Reticle's flow `success` is now a **declared, deterministic, post-settle consequence** over program truth — not just "the element is there" — and the same flow replays with no LLM, so a CI gate diffs the verdict exactly (0% flake) at a fraction of the tokens an LLM re-drive costs.

### Added

- **`state` predicate — assert store truth** (`packages/server`, `packages/protocol`). Assert a value inside a registered store the DOM never showed: `{ kind: "state", store?, path, equals? }`, with `equals` a literal or a `{ $gte | $contains | $length }` operator. Available in `reticle_assert`, `reticle_act_and_wait`, as a per-step `assert-state` invariant, and as a flow `success-state` golden end-condition. Catches a UI-vs-store **desync** and a dead-handler **green-but-wrong** regression that no DOM read can — the success oracle fails when the store didn't change, with no testid drift.
- **Flow consequence family — `net { count }`, `console { absent }`, `state { hold }`** (`packages/server`, `packages/protocol`). A flow's `success` (via `reticle_annotate success-state`) now compiles to a real predicate over more than presence: `net { count }` asserts a request fired EXACTLY N times (catches a **double-submit** / retry-storm a presence check passes); `console { absent }` asserts the action left a **clean console** (catches a silent `console.error`); `state { hold }` asserts an unrelated store path **did not move** (catches an action's unintended **blast-radius** side-effect). Cardinality/absence/invariant predicates are read **post-settle** so a wait-until-true check can't pass before the regression lands.
- **Design-token awareness in `reticle_inspect`** (`packages/server`, `packages/browser`). Inspect now reports theme compliance — `{ colorToken, backgroundToken, offTheme, tokenCount }` — so an off-palette color (a value no design token defines) is observable in one call, not just "a color rendered."
- **React render meter** (`packages/react`). `installRenderMeter()` augments the React DevTools hook to count commits and registers an `__reticle_renders` store; `reticle_state` reads the commit rate, so a **wasted-render storm** (re-renders with identical output → no DOM mutation) is visible where a screenshot/DOM tool sees an idle page. `getRenderStats()` / `resetRenderMeter()` exported; host-safe.
- **Component auto-anchors — address any element with zero hand-added testids** (`packages/browser`, `packages/server`). `reticle_query by:"component"` resolves elements by component identity / source location, and recorded flows synthesize a stable `component` anchor (fiber → component → `file:line`) when no `data-testid` resolves, instead of degrading the step.
- **`reticle_flow_verify` — one-call suite regression check** (`packages/server`). Re-verify a K-flow suite and get one consolidated verdict (passing counted, only failures detailed), so an agent's read-cost is roughly constant in suite size.
- **On-demand tool loading — `dynamic` / `hybrid` MCP profiles** (`packages/server`). Load tool schemas as needed instead of paying for the full set up front, cutting the agent's per-turn token floor.
- **Richer observation** (`packages/browser`, `packages/server`): a `net.pending` signal for in-flight / hung requests; generic-container text in the snapshot so a silent DOM removal is visible; a grid layout signature so a CLS/layout regression shows up.

### Changed

- **Leaner agent verify loop** (`packages/server`). Terser tool descriptions and compact `reticle_network` / `reticle_console` projections on the lean profiles roughly halve the per-turn token cost; `core` is the default profile tuned for the build-verify loop.

### Fixed

- **`reticle_visual_diff` returned a shape its schema rejected** (`packages/server`). The tool's `outputSchema` declared `{ ok, match, diffPct }` but the handler returned the diff engine's real shape (`{ matched, changedPixels, ratio, … }`) and never set `ok`, so every real diff failed MCP output validation. The schema now matches the handler (`ok` plus the real fields); dimension-mismatch returns `{ ok:false, reason }`.
- **`reticle_flow_save` / `reticle_save_recorded` output schemas didn't match their handlers** (`packages/server`), breaking those tools over MCP. Schemas corrected.
- **`reticle_state` output validation + path scoping** (`packages/server`, `packages/protocol`). `reticle_state` no longer fails output validation, and `path`/`depth` selection is applied **in-page before transport truncation**, so a scoped read of a large store is no longer truncated to the wrong fields.
- **Transport sanitizer no longer redacts design-token fields** (`packages/browser`). A broad `token` redaction rule was clobbering `colorToken` / `tokenCount`; it's now scoped to auth-credential patterns.

## [0.6.10] — 2026-06-18

### Added

- **Deterministic waiting — the `settled` predicate** (`packages/server`). A new predicate `{ kind: "settled", quietMs }` passes once network + structural-DOM activity has been quiet for `quietMs` (default 500ms); ambient `dom.text`/animation churn (count-ups, spinners) is ignored so an animated page can still settle. Usable in `reticle_wait_for` and `reticle_assert`, and composable inside `allOf` with the consequence you expect. Replaces fixed sleeps — the #1 cause of flaky agent tests.
- **`reticle_act_and_wait` auto-settle** (`packages/server`). Omit `until` and the tool waits for the page to settle instead of requiring a predicate — "act, then wait for quiet" is now a single zero-config call, the documented alternative to a sleep.
- **`reticle_query` token controls** (`packages/server`) — `limit` (cap returned descriptors; reports `total` + `truncated` so a trim is never silent) and `count_only` (return just the match count).
- **`reticle_network` / `reticle_console` token controls** (`packages/server`) — `limit` (keep the most recent N matches, reporting `total` + `droppedOldest`) and a `cost:{bytes,tokens}` hint, matching the other read tools so the agent can self-budget everywhere.
- **`reticle_domain` `mustHold` per flow** (`packages/server`) — each flow now reports the success consequence that must hold for it (signal name / net URL), so an agent can answer "what are the critical flows and what must hold for each?" from the domain model alone.

### Changed

- **Self-healing now verifies the consequence before persisting** (`packages/server`). `reticle_flow_heal` with `apply:true` re-replays the healed flow and re-asserts its success consequence; if a rebound locator resolves but the flow no longer satisfies its intent, the write is **refused** (`status:consequence_broken`, file untouched). It heals the locator, never the intent.

### Fixed

- **Browser observers fully restore patched globals on teardown** (`packages/browser`). The network, route, and console observers stored a bound copy and assigned it back on teardown, so `window.fetch` / `history.pushState` / `console.*` were never restored to their original identity. They now keep the true original for restore and a bound copy only for invocation.

## [0.5.0] — 2026-06-15

### Added

- **`reticle mcp` — smart proxy with auto-start** (`packages/server`). Run `reticle mcp --drive <url>` and you're done: it starts the daemon if one isn't running, waits for it to be ready, then bridges Claude Code's stdin/stdout to the daemon's SSE endpoint. Users no longer manage the daemon manually.
- **`reticle mcp --drive <url>` / `reticle serve --drive <url>`** — pass a URL and Reticle launches its own Playwright browser at that URL, giving the agent full autonomous control without relying on the user's open browser tab.
- **`reticle mcp --headed` / `--headed` flag** — opt in to a visible browser window so you can watch exactly what the agent is doing.
- **Three new update MCP tools** (`packages/server`):
  - `reticle_version_info` — returns the installed version, execution kind (npx / global / local), and whether a newer version is available on npm.
  - `reticle_apply_update` — upgrades Reticle in place; requires `confirm: true` to actually run.
  - `reticle_rollback` — downgrades to the previous version; requires `confirm: true`.
- **Presenter mode** (`packages/browser`, `packages/server`) — `reticle.connect({ present: true })` mounts a dev-only HUD overlay that the agent can control: `reticle_narrate` shows a caption, `reticle_highlight` draws a ring around any element. The HUD is excluded from snapshots and tree-shaken in production.
- **Unified `SKILL.md` at repo root** — a single skill file auto-detects mode: setup wizard on first run (no `.reticle.json`), live-app testing on every run after. Covers Claude Code, OpenCode, Codex CLI, Cursor, Windsurf, VS Code, and Zed MCP config formats.
- **`.reticle.json` project config** — written after first-run setup; persists `port`, `headed`, `framework`, and `harnesses` so subsequent runs need zero questions.
- **`dev:reticle` script** in `apps/demo` — second Vite dev server on port 4310, isolated from the user's normal dev port.

### Fixed

- **All-throttled session auto-selection** (`packages/server`). When every connected tab is hidden (e.g. user is in VS Code with Chrome on another desktop), `SessionManager.resolve()` now picks the session with the freshest heartbeat instead of throwing `"multiple sessions connected"`.
- **Presenter HUD shows on bridge connect** — the overlay now mounts as soon as the SDK connects to the bridge, not only after the first `reticle_narrate` call.
- **`reticle_narrate` MCP schema validation** — relaxed the output schema so the tool no longer rejects responses from narration calls.
- **`reticle_inspect` / `reticle_clock` output schemas** — relaxed to pass through extra fields instead of stripping them, fixing spurious validation errors.

---

## [0.4.0] — 2026-06-11

First public release. Reticle is the **proof layer for AI agents** — it verifies your running web app from the inside and returns a **verdict with evidence** instead of a screenshot.

### Added

- **The verify loop over MCP** — `look → act → observe → assert`. `reticle_assert` evaluates a structured predicate against the live app and returns `{ pass, evidence, failureReason? }`, typically in ~100 tokens.
- **Six reaction types in one assert** — network calls, DOM changes, SPA navigation, console & errors (including "no errors during this flow"), animations, and app **signals**.
- **App signals** — `reticle.signal()` lets your app emit the facts a screenshot can't see (the store committed, the webhook arrived); a bundled ESLint rule flags mutations that forgot to emit one.
- **Regression detection** — `reticle_baseline_save` + `reticle_diff` to catch silently removed elements or new console errors before they ship.
- **Source mapping** — DOM element → React component → `file:line`, on React 18/19 and Next.js (keeps SWC).
- **Autonomous crawler** (`reticle_crawl`) that clicks every reachable control and classifies what breaks.
- **Declarative spec runner** (`@reticlehq/core/test`) for signal-bound, headless verification specs.
- **The `reticle` CLI** — bridge + MCP server, plus `reticle drive` for a launched browser.
- **Single package, subpaths** — `@reticlehq/core` ships the browser SDK (`.`), the server (`./server`), the spec runner (`./test`), source mapping (`./next`, `./babel`), and the lint rule (`./eslint`) — one install.

### Notes

- **Dev-only and localhost-only by default**; observers are additive and reversible, and the SDK is tree-shaken out of production. No telemetry.
- **Token efficiency** — a full verify loop is ~100 tokens vs ~7,300 for a full-tree snapshot (~73× on the common loop; ~1.8× full-tree-vs-full-tree). See [`docs/token-efficiency.md`](docs/token-efficiency.md) for the methodology and honest caveats.

[1.0.0]: https://github.com/reticlehq/reticle/releases/tag/v1.0.0
[0.9.0]: https://github.com/reticlehq/reticle/releases/tag/v0.9.0
[0.8.0]: https://github.com/reticlehq/reticle/releases/tag/v0.8.0
[0.7.0]: https://github.com/reticlehq/reticle/releases/tag/v0.7.0
[0.6.10]: https://github.com/reticlehq/reticle/releases/tag/v0.6.10
[0.5.0]: https://github.com/reticlehq/reticle/releases/tag/v0.5.0
[0.4.0]: https://github.com/reticlehq/reticle/releases/tag/v0.4.0
