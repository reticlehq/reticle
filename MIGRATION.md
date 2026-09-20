# Upgrading to Reticle v3

**From 2.x to 3.1.0.** This is the whole upgrade, in one place, in order.

If you have never installed Reticle, you do not need this file. Read [Getting started](docs/getting-started.md) instead.

---

## Read this first: there is no 3.0.0 on npm

You will see a `[3.0.0]` section in the [changelog](CHANGELOG.md) and a `v3.0.0` tag in git. That version was tagged but **never published**. The only v3 you can install is **3.1.0**, and it contains everything from both.

So the jump you are making is **2.14.0 → 3.1.0**, and this file covers all of it. You do not need to read the 3.0.0 changelog section to upgrade safely; everything in it that affects you is repeated below.

---

## Do I have to do anything?

Work down this list. Most people stop at the first or second row.

| If you… | You must |
| --- | --- |
| Let your agent call Reticle's tools, with no allowlist and no scripts | **Nothing.** Upgrade and carry on. Old tool names still work — see [1](#1-most-tool-names-changed-old-ones-still-work). |
| Keep an allowlist of tool names (`allowedTools`, an MCP permission rule, a prompt that names tools) | **Update the names by hand.** See [2](#2-if-you-keep-a-list-of-tool-names-you-must-edit-it). |
| Use screenshots, visual diff, the fake clock, network mocking, storage, or save/replay flows by name | **Set one environment variable.** See [3](#3-twelve-tools-are-no-longer-callable-by-default). |
| Run `reticle init` in a script or CI job | **Check your flags, and add a second command.** See [4](#4-reticle-init-no-longer-drives-your-app). |
| Pin Node, or run Node 20.0–20.10 | **Upgrade Node to 20.11 or newer.** See [5](#5-node-2011-is-now-the-minimum). |
| Run a licence scanner over your dependencies | **Add two SPDX identifiers to its allowlist.** See [6](#6-licence-identifiers-changed-the-terms-did-not). |
| Vendor, mirror, or air-gap your dependencies | **Two new packages enter your tree.** See [7](#7-two-new-packages-appear-in-your-dependency-tree). |
| Pin Playwright below 1.50 | **You will see a peer warning.** See [8](#8-playwright-is-now-an-optional-peer-dependency). |

Nothing else changed in a way that can break you. Package names are unchanged, every import path that worked in 2.x still resolves, and no CLI command was removed.

---

## 1. Most tool names changed. Old ones still work

Reticle used to advertise seventeen tools. It now advertises **nine**, and ten of the old names live on as an `action` on one of the nine.

| You used to call       | Now call                                 |
| ---------------------- | ---------------------------------------- |
| `reticle_snapshot`     | `reticle_look { action: "page" }`        |
| `reticle_query`        | `reticle_look { action: "find" }`        |
| `reticle_inspect`      | `reticle_look { action: "element" }`     |
| `reticle_state`        | `reticle_look { action: "state" }`       |
| `reticle_network`      | `reticle_observe { action: "network" }`  |
| `reticle_console`      | `reticle_observe { action: "console" }`  |
| `reticle_wait_for`     | `reticle_assert { action: "wait" }`      |
| `reticle_sessions`     | `reticle_session { action: "list" }`     |
| `reticle_feedback`     | `reticle_session { action: "feedback" }` |
| `reticle_act_sequence` | `reticle_act { steps: [...] }`           |

**Why this is mostly painless:** if an agent calls an old name, Reticle answers with the new call rather than "tool not found". Nobody gets stuck.

**Why it is not entirely painless:** a redirect only helps once the call reaches Reticle. Anything that filters tool names _before_ the call — see the next section — refuses first, and Reticle never hears about it.

`reticle_tools` prints the live list of nine plus every old name and where it went.

---

## 2. If you keep a list of tool names, you must edit it

This is the one change that can silently stop things working, because the failure happens in your agent's configuration and never reaches Reticle.

Check these places for any of the ten old names in the table above:

- an `allowedTools` / `disallowedTools` list in your agent config
- an MCP permission or auto-approval rule
- a prompt, CLAUDE.md, or rules file that tells the agent which tools to call
- a CI script that invokes tools by name

**The symptom if you miss it:** the agent asks for `reticle_snapshot`, your allowlist does not contain it, the call is refused before Reticle is asked, and Reticle looks broken when it is not.

**The safest edit:** allow the ten current names — `reticle_act`, `reticle_act_and_wait`, `reticle_assert`, `reticle_look`, `reticle_navigate`, `reticle_observe`, `reticle_run`, `reticle_session`, `reticle_tools`, `reticle_verify` — and delete the old ones. Do not leave `reticle_run` out: it is the hatch every unadvertised tool is reached through, and an allowlist without it turns section 3 into a dead end.

---

## 3. Twelve tools are no longer callable by default

The default surface is smaller than 2.x's: twelve tools that used to be advertised no longer are. They are all still REACHABLE, through `reticle_run { tool, args }`, which dispatches to any registered tool by name whether or not it is advertised.

3.1.0 shipped one release in which the hatch was absent and those twelve were reachable by nothing at all. That was a defect, and it is fixed: if you are reading this against 3.1.0 exactly, upgrade rather than working around it.

These twelve are affected. Unlike the ten in section 1, they are not renamed — you call them through the hatch, or advertise them outright:

`reticle_capabilities` · `reticle_clock` · `reticle_context` · `reticle_flow_replay` · `reticle_flow_save` · `reticle_intent` · `reticle_network_mock` · `reticle_record` · `reticle_screenshot` · `reticle_storage` · `reticle_visual_diff`

**If you use any of them, do one of these three things.**

**The one-liner**, which needs no restart and no configuration — the hatch is on the default surface:

```jsonc
reticle_run { tool: "reticle_screenshot", args: { … } }
```

**Or** start the daemon with the full surface, and call them directly by name:

```bash
RETICLE_ADVERTISE_ALL_TOOLS=1 npx @reticlehq/server serve
```

That advertises all thirty tools with output schemas. It is read **once, at daemon startup**, so setting it in an already-running daemon does nothing — restart it. It costs roughly seven times the per-turn schema budget, which is why it is not the default; it is meant for test suites that call by name, not for a running agent.

**Or** use the advertised replacement, which is usually better:

| Instead of | Use |
| --- | --- |
| `reticle_flow_replay` | `reticle_verify { action: "flows" }` — replays every saved flow, no model in the loop |
| `reticle_record` + `reticle_flow_save` | `reticle_verify { action: "explore", persona: "…" }` — it drives the app and **records what it drove as saved flows** for you, which is the recommended path. Building a flow by hand with `reticle_record` works through `reticle_run`. |

`reticle_capabilities`, `reticle_context`, `reticle_intent`, screenshots, visual diff, the fake clock, network mocking and storage have **no advertised equivalent**. Reach them through `reticle_run`, or advertise them with the environment variable.

---

## 4. `reticle init` no longer drives your app

In 2.x, `reticle init` wired your project **and then** drove one flow to a verdict. It now stops as soon as the app connects.

This was split because they are two different jobs. Onboarding is finished when the SDK is in your page and the tools have something to talk to — that connection is the proof it worked. Proving a _flow_ is the first run, and it is a separate command.

**Before:**

```bash
npx @reticlehq/server init --flow "a user checks out"
```

**After — two steps:**

```bash
npx @reticlehq/server init
```

then, once it reports a connected session:

```
reticle_verify { action: "explore", persona: "a user checks out" }
```

or from a shell:

```bash
npx @reticlehq/server verify <url> --explore --persona "a user checks out"
```

### Flags that now refuse

`--flow`, `--no-drive` and `--drive-model` **exit non-zero**. They do not silently do nothing, and they are not reported as "unknown argument" — each one names the replacement above, because the agent instruction files shipped in 2.x still mention them.

**If you have `--no-drive` in a script**, delete it. It asked `init` not to drive, and `init` no longer drives, so the flag is not needed. This is the most likely one to bite: a CI job passing `--no-drive` went from working to exiting 1.

**If you want the old write-only behaviour** (write files, register the MCP server, pre-approve tools, and stop — no dev server, no browser), that is `--files-only`, and it is unchanged.

### Exit codes changed meaning

`init` used to exit non-zero if no _verdict_ was produced. It now exits non-zero if nothing _connected_. A job that treated a non-zero exit as "verification failed" should now read it as "onboarding did not finish".

---

## 5. Node 20.11 is now the minimum

`@reticlehq/server` declares `engines: { node: ">=20.11" }`. It was `>=20.0.0`.

If you are on Node 20.0 through 20.10 the install will fail. Every other Reticle package still accepts `>=20.0.0`; only the server moved. Node 20.11 is a patch release of the same LTS line, so this is normally a one-line change to your `.nvmrc`, Dockerfile or CI matrix.

---

## 6. Licence identifiers changed; the terms did not

Three packages now declare a real SPDX identifier where they used to declare a pointer to a file:

| Package             | 2.14.0                   | 3.1.0          |
| ------------------- | ------------------------ | -------------- |
| `@reticlehq/server` | `SEE LICENSE IN LICENSE` | `FSL-1.1-ALv2` |
| `@reticlehq/init`   | `SEE LICENSE IN LICENSE` | `FSL-1.1-ALv2` |
| `@reticlehq/test`   | `SEE LICENSE IN LICENSE` | `FSL-1.1-ALv2` |

**The licence terms are identical.** This is a metadata fix: the old value is not a recognised SPDX identifier, so scanners reported it as unknown. `@reticlehq/core` and `@reticlehq/browser` remain `Apache-2.0`, unchanged.

If you run a licence allowlist in CI, add `FSL-1.1-ALv2`. A tool that previously passed these packages as "unknown, needs review" may now fail them as "not on the allowlist" — the packages did not change, your scanner can just finally read them.

---

## 7. Two new packages appear in your dependency tree

- **`open-verification`** — the verification protocol itself: the vocabulary and rules a verdict is derived from, split out so it can be implemented by somebody other than us. It is a dependency of `@reticlehq/core`, so it arrives whether or not you ask for it. **Note the name is not scoped** — it is `open-verification`, not `@reticlehq/open-verification`.
- **`@reticlehq/engine`** — the rules that decide a verdict, with no browser, daemon or CLI attached.

Both are `Apache-2.0`.

**This matters to you only if you vendor, mirror or air-gap your dependencies.** If you run a private registry with an explicit allowlist, add both. If you use a scoped-only `.npmrc` rule such as `@reticlehq:registry=...`, be aware it will **not** match `open-verification`, because npm keys registry settings on a scope and an unscoped package has none — that request goes to npmjs.

---

## 8. Playwright is now an optional peer dependency

`@reticlehq/server` declares `playwright` as an optional peer at `>=1.50`. If your project pins an older Playwright you will see a peer warning on install. Nothing breaks; the warning is accurate, and Reticle's driven-browser features want the newer one.

If you do not use Playwright at all, ignore this — the peer is optional and nothing is installed.

---

## Rolling back

Downgrading to 2.14.0 works: reinstall the old version and restore your old tool-name allowlist.

One caveat we have not fully tested: 3.1.0 writes files under `.reticle/` (saved flows, the learned ambient map) that 2.14.0 does not know about. We have not verified that a 2.14.0 daemon reads a 3.1.0-written `.reticle/` without complaint. **If you roll back, delete the `.reticle/` directory first** and let the old version recreate it. You lose saved flows, which the new version would have replayed for free; nothing else.

---

## Still stuck?

- `npx @reticlehq/server doctor` — one command, checks the whole setup
- `reticle_tools` — prints the live tool surface and every old name's new home
- [Open an issue](https://github.com/ReticleHQ/reticle/issues)
