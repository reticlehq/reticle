# Roadmap

Direction, not dates. What actually shipped is in the [CHANGELOG](./CHANGELOG.md); how it ships is in [RELEASING](./RELEASING.md). Priorities shift with what users hit — open an issue to push on any of these.

Each item below has a **tracking issue** labelled `roadmap`: that's where the design gets argued and where you say "I'll take this". Anything unclaimed is genuinely up for grabs — comment before you start so two people don't build it twice. Live discussion happens in [Discord](https://discord.gg/BwAbzv9ZRz) `#roadmap`.

## Guiding bet

Reticle's edge is seeing the **program**, not the pixels — app state, signals, request cardinality, swallowed errors — the bug classes a DOM/screenshot tool structurally can't catch. Everything below serves making that catch more reliable, cheaper, and easier to adopt.

## Direction: one proof, every realm

Reticle started with the web app a coding agent builds. It goes **general purpose**: proof for any task an agent does, wherever the agent acts. The job stays the same everywhere: act, read what happened from the inside, and give a verdict with its evidence, or say that it cannot tell.

A **realm** is one kind of environment that Reticle can read and drive ([adapters/realm](adapters/realm/README.md)). Each realm joins the same bridge, so the same tools and the same verdict rules work in all of them.

| Realm | What it reads and drives | State |
| --- | --- | --- |
| **Browser** | A web page, from an SDK inside it: DOM, network, state, console, source lines | shipped |
| **Electron, Tauri** | A desktop app built on a webview, and the IPC boundary between its halves | shipped |
| **Computer** | Any desktop application on macOS, Windows and Linux, through the accessibility tree of the operating system. No SDK | shipped in 3.11 |
| **CLI** | A command-line program: what it prints, its exit code, and what it does to the filesystem | a package (`@reticlehq/cli-realm`) in 3.11; a session for the agent tools next |
| **Backend** | A server, from the inside: the requests it takes, its logs, its queries, the jobs it starts | planned |
| **More** | Databases, queues, cloud consoles, mobile | explored as the realms above grow |

**Realms talk to each other.** A real task crosses realms: a click in a page sends a request that a backend handles, writes a row, and opens a dialog of the operating system. Reticle follows the task across them:

- **Shipped:** `reticle_attach_tab` joins a page in the person's own browser. `reticle_session { action: "board", carry }` carries a value from one session to another and proves that it arrived. A finding says when an action continues in a window the page cannot enter, and how to follow it on the computer.
- **Next:** one verdict over several realms (_"the click in the page wrote this row, and the desktop app shows it"_). A saved flow whose steps go through more than one realm, and replays with no model. The agent chooses the realm for each step, and Reticle says which one can prove the claim.

### The computer realm, next

- **Choose the right way for each step:** the accessibility tree first, the real pointer when a control has no element, and the words in a screenshot when the application has no tree.
- **Close the gaps that OSWorld finds.** Measure on the [OSWorld](https://os-world.github.io) benchmark, fix what a person can click and the realm refuses, and make reads cheaper, so that a read does not cost a step.
- **The same on all three systems:** the HUD, `--open` and `--doctor` on Windows and Linux, and a path for the real pointer on Wayland.
- **More feedback from agents.** Each `reticle_feedback` report on the computer realm goes to the team, and the reports set what we fix next.

## Near-term

- **Zero-install tier.** Drive any React app over CDP with no SDK installed — component state, network, and console at parity with the read everyone benchmarks — as the on-ramp, with the SDK as the upsell for signals, named stores, and `file:line`. (The fiber reader already works; the remaining piece is a boundary decision on where the CDP-injected reader lives.)
- **More framework state adapters.** Broaden first-class `reticle_look { action: "state" }` support across the stores React and Next apps actually use.
- **Sharper diagnosis.** Keep tightening the failure capsule — first-divergence + blast radius + the exact `file:line` — since the measured win is fewer agent tool-calls to a fix, not just detection.
- **The install has to end in a verdict.** Most people who install never see one. `init` now waits for a real page to connect rather than reporting the files it wrote, and the funnel from install to first verdict is instrumented end to end. Keep pulling on whatever the next narrowest point turns out to be.

## Ongoing

- **Verifier honesty.** The standing invariant: a green never rests on evidence it doesn't have. New false-green classes get fixed as they're found, each with a regression guard.
- **Cost & scale.** Keep the per-call token cost flat as apps grow, and the SDK overhead under budget on large DOMs and long sessions.
- **OSS health.** Externally-verifiable security posture, clean packaging, and docs that get a new user to first success fast.
- **A gate that can see its own drift.** Every check compares against a pinned reference as well as the previous run, because a cost that lands once and then holds is invisible to a gate that only looks one step back.

## Enterprise

SSO/SAML, SCIM, RBAC, audit logs, and verify-before-merge policy gates are planned for the hosted Reticle platform, not for this repository. Every package in this repository is Apache-2.0, and the verification engine stays free.

## Beyond the browser: mobile and native

**Being explored, and deliberately not promised.** The ask is real and repeated: React Native, Flutter, native iOS and Android. The honest framing is that this is a second product line rather than a platform flag, and the roadmap should say so before anyone builds against it.

Reticle's whole mechanism is a dev-only SDK **inside** the running app reading the DOM, JS-side network, and the React fiber tree. How much of that survives varies enormously:

| Platform | What exists to read | Honest position |
| --- | --- | --- |
| **Web** | everything | shipped |
| **Electron, Tauri** | a webview plus an IPC boundary | shipped |
| **Any desktop application** | the accessibility tree of the operating system, read from outside by the computer realm | shipped in 3.11, with no SDK and no `file:line` |
| **React Native** | JS runtime and a React reconciler, so state, network, console and component identity plausibly transfer; no DOM, so query and actions need the native view tree | the most tractable, and where any first increment should start |
| **Flutter** | no DOM, no JS, renders to a canvas; a semantics tree and a VM Service protocol exist | a separate SDK in Dart. Nothing in `@reticlehq/browser` transfers. `init` refuses it by name today, and that refusal is correct until such an SDK exists |
| **Native Android** | own-process logcat, a process-wide Compose state observer, and an accessibility tree including the Compose virtual nodes, all public and needing no opt-in. Compose already stamps `file:line` into the composition | more reachable than expected. `adb reverse` solves the transport outright |
| **Native iOS** | a private view-debug tree with no source coordinates, no generic way to read `@State`, and no reverse tunnel to a physical device | hardest of the four. Simulator-only is the honest first increment; `file:line` needs annotation |

Two things have to be settled before any of it is scheduled, and they are the actual work:

1. **The wire contract is DOM-shaped.** `@reticlehq/core` speaks `dom.added`, `dom.removed`, `dom.attr`. A Dart or Swift SDK cannot speak that as written, so the reusable asset is the contract only if it grows a platform-neutral node-tree abstraction first. That may be a breaking change rather than an addition.
2. **In-process action dispatch.** Reticle acts from inside the app. If a platform can only be driven by an external runner, then "support" there means something different from what it means on web, and saying so up front is cheaper than discovering it after an SDK exists.

Until both are answered, treat this section as a direction rather than a commitment. The platform research, including the parts that contradict the first draft of this table, is on [#325](https://github.com/reticlehq/reticle/issues/325).

## Not planned

- Turning Reticle into a test-script framework or a scraper. Reticle goes general purpose as **proof**: it reads what an agent's action did and gives a verdict. A tool that only replays clicks is not that. For releases and a matrix of browsers, Playwright is the right tool, and the honest recommendation is to use both.
- Claiming a platform is supported before an agent can drive a real app on it and get a verdict. "Installed" already had to be redefined as "a verdict was produced" once; a platform badge earned by a scaffold rather than a drive is the same mistake at a larger scale.
