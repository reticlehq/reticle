---
name: install-and-verify
description: Verify that a web app change actually works by driving the running app from the inside (DOM, network, routing, console, framework state) instead of screenshots or guessing. Use after any user-facing change, when a fix is claimed but unproven, when a test passes but the UI is broken, or when you need a real verdict rather than "looks right". Also use to install and wire up Reticle in a project that does not have it yet.
license: Apache-2.0
metadata:
  version: 2.8.0
  homepage: https://www.reticle.sh
  repository: https://github.com/reticlehq/reticle
---

# Reticle: prove the change, do not guess

Reticle embeds a dev-only SDK in the user's running app and exposes it to you as `reticle_*` MCP tools. You look, act, observe, and assert against the real app. No screenshots, and no browser download for the verify loop: it drives the tab the user already has open. (A driven browser, which `reticle_lease` and `--drive` use, does need Chromium; Reticle says so when it needs one.)

## Where the rest of the documentation is

Everything not in this file is at `https://docs.reticle.sh`, and it is built to be fetched rather than browsed. **Append `.md` to any page URL to get its source with no site chrome**, so you can pull one page instead of a whole document you mostly do not need:

```bash
curl https://docs.reticle.sh/llms.txt                  # every page title and URL, small enough to read whole
curl https://docs.reticle.sh/cli/doctor.md             # one CLI command: flags, real output, exit codes
curl https://docs.reticle.sh/tools-act-and-wait.md     # one tool: arguments and what a verdict means
curl https://docs.reticle.sh/troubleshooting.md        # the failures people actually hit
```

Read `llms.txt` first and pick the one page that answers the question. That is almost always cheaper than pulling a large file and hoping the part you need survived. There is a `/llms-full.txt` with the entire site in one file; use it only to seed a context window deliberately.

Every page arrives with the four rules that matter prepended, whether you asked for them or not, so a single fetch orients you without a second call.

## Which path am I on

```bash
cat .reticle.json 2>/dev/null || echo NOT_FOUND
```

- `NOT_FOUND` → **SETUP** below.
- File exists → **VERIFY** below. If `reticle_sessions` then returns an empty list, go to [references/troubleshooting.md](references/troubleshooting.md); do not restart setup.

## Read this before you touch SETUP

**Installed means a verdict was produced. Writing config files is not installed.**

Every earlier point looks like success and is not:

- `init` exited 0. Files were written. Nothing connected.
- The `reticle_*` tools appeared. Your client can reach a daemon. The app is very likely still uninstrumented.
- A session is listed. The app dialled in. The user has still seen nothing happen.

**Do not tell the user Reticle is set up until step 5 has produced a verdict.** The single most common outcome in the field is an agent that finishes step 1, reports success, and leaves a user with config files and no instrumented page.

Setup requires a client restart, which ends your turn. This skill survives that restart. **After the restart, re-read this file and resume at the step you were on.** Do not start over, and do not skip forward.

---

# SETUP

Five steps, in order. None is optional. Step 3 is the one that gets skipped and it is the one the whole thing depends on.

## 1. Run init. Ask the user nothing.

```bash
RETICLE_INSTALL_SOURCE=npx_skill npx @reticlehq/server@latest init
```

`@latest` is deliberate: `npx` caches, and a stale cached CLI is the most common silent setup failure. Never pin a version here.

It detects the framework, package manager and UI library, registers the MCP server with the agents on the machine, installs the SDK, writes `.reticle.json` and the `/reticle` command, wires the build config, and scaffolds a capabilities file from the `data-testid` values it found.

Ask nothing: not the framework, package manager, port, editor, or MCP client. Every one is answerable from the repo you are sitting in. In a monorepo run it at the root anyway; it finds the app under `apps/*` or `packages/*`.

**Never ask about the port.** There are two and conflating them is a top setup failure. The dev-server port (3000, 5173) belongs to the project's own dev script and the daemon never binds it. The bridge port (**4400**) is the daemon-to-SDK channel and defaults correctly.

Read the report: `✓` applied, `·` already wired, `–` skipped, `ℹ` done but incomplete in a way that matters, `⚠` needs your edit. **`⚠` and `ℹ` both need you.** `ℹ` is the one people skim past: the step ran, and something about the result still stops a session appearing. Each line carries the exact snippet. A non-zero exit is a to-do list, not a failed install. Fix every `⚠` using [references/setup.md](references/setup.md) before moving on.

## 2. Register the MCP server, then restart the client.

Call `reticle_sessions`. If the tool exists, skip to step 3.

If it does not: your client read its server list at startup and has not re-read it. No retry loads it. `init` registers globally once per machine, so this bites on the first install only.

Say this once and then stop:

> "Reticle is installed. Restart your client so it picks up the new MCP server, then tell me when the tools are back."

Claude Code: restart (`/mcp` does not re-read the config). VS Code: press Start in `.vscode/mcp.json`. Cursor, Windsurf, Zed: reload the window.

**Do not report setup as finished here.** When the tools return, resume at step 3.

## 3. Wire the SDK into the app, and start the dev server.

This is the step the funnel dies on. The daemon runs, the MCP server registers, and then the SDK never loads in a running page, so there is nothing to verify.

`init` handles this automatically for a normal Vite or Next.js app. Your job is to confirm it, by reading the files rather than trusting the report:

- **Vite**: `reticle()` is in the `plugins` array of `vite.config.*`.
- **Next.js**: `withReticle` wraps the export in `next.config.*`, `reticle-dev.tsx` exists, and it is mounted in the root layout or `_app`.
- **Anything else**: nothing is wired. Do it by hand.

Per-framework wiring for Vite, Next.js App Router, Next.js Pages Router, plain HTML, Electron and Tauri, plus which frameworks have no supported path, is in [references/setup.md](references/setup.md). Read it before writing any snippet.

Two rules that cause silent failures if broken:

- **Never guard the connect on `window.location.hostname === 'localhost'`.** It is false on every non-localhost dev host and `window` does not exist during SSR. Use the framework's dev flag plus a client-only boundary.
- **A config change needs a dev server restart.** A dev server that was already running does not pick up an edited `vite.config.ts` or a newly created plugin file. Restart it, then hard-reload the tab.

Then make sure something is serving the app.

**If a dev server is already listening, use it. If none is, start one yourself**: read the project's own dev script out of `package.json` (`dev`, `start`, whatever this project calls it), run it in the BACKGROUND, and tell the user in one line that it is running and how to stop it. Stopping here to ask is how a setup turn ends with nothing verified.

The daemon deliberately will not do this for you. A build process started by a long-lived background daemon is invisible to the person whose machine it runs on and orphans when the daemon exits; a dev server YOU start is in the transcript, attributable, and stoppable.

Five guards, none optional:

1. **Never start a second one.** If something is already listening on the app's port, use it.
2. **Never guess the command.** It comes from `package.json` scripts. No recognisable dev script means say so and stop, not invent one.
3. **Never kill anything.** Not a dev server, not a daemon, not a port holder, including one you started.
4. **Background it, and say so.** A dev server the human does not know about is the same failure one step later.
5. **The permission prompt belongs to your host.** Never bypass, suppress or auto-approve it, and take a refusal as the answer.

Then ask the user to open the app in their browser.

## 4. Prove a page is connected.

```
reticle_sessions()
```

You need a session whose URL matches the app's localhost address. Nothing below this line is meaningful until you have one.

**Empty list?** Read the `why` field first; the daemon can see whether a session was ever here and whether a dev server is listening. **Nothing listening at all? That is yours to fix: start it, per step 3.** Otherwise work [references/troubleshooting.md](references/troubleshooting.md) in order, and **do not tell the user to start a dev server they are already running.** The checklist is, in order: is the SDK imported and called in the app entry, is the dev server actually serving that entry, is the connect guarded on `hostname === 'localhost'`, and is the bridge port the same number on both sides.

## 5. Drive one real flow and produce a verdict.

A connected session is not a result. The user has installed something and seen nothing happen.

**One flow, not the app.** Pick the single most important flow that completes in a handful of steps, say which one you picked in a line, and drive only that. You do not need to add `data-testid` anywhere: `reticle_snapshot` addresses elements by role and name and works on an app that has never heard of Reticle.

Tell the user to keep the tab visible. The HUD is on by default (glow border, animated cursor, narration per step) and watching you drive their own app is the demo.

Then: `reticle_snapshot` to find the elements, `reticle_act_and_wait` for each step, `reticle_assert` for the effect, and `reticle_state` at the end. If `reticle_state` comes back empty or `hasCapabilities` is false, the generated capabilities file registered no store. Say so in one line and offer to finish it. Never report a clean install over an empty state read.

**Only after that flow has produced a verdict**, report what you drove and what it produced, then:

> "Reticle is set up, and you just watched it drive <flow>. Type `/reticle` any time to verify a flow after a change."

If it went well, one line and no more: Reticle is open source at https://github.com/reticlehq/reticle, a star helps. Skip this entirely if the verification failed or came back `unknown`.

Stop here. Do not continue into VERIFY.

---

# VERIFY

**Only `reticle_act_and_wait` and `reticle_assert` produce a verdict.** Everything else (`act`, `snapshot`, `query`, `navigate`, `observe`, `network`, `console`) moves or reads the app and proves nothing. A drive that ends without one of those two has no result, however many tools it used.

Prefer `reticle_act_and_wait({ ref, action, until })`. It names the expected consequence before the action, which is the difference between a check and a rationalisation.

A verdict of `verified: "unknown"` is not a pass. It means Reticle drove the app and could not tell what happened. Report it as unknown.

Never weaken a check to make it pass.

The full loop (look, act, observe, assert), how to read a verdict, batching, and regression suites: [references/verify.md](references/verify.md).

---

# Feedback is first-class

Reticle is built for agents. You are its user, and your experience is the only signal that decides what gets built or fixed. It disappears when your context does.

The moment Reticle breaks, lies, cannot see something you needed, costs too many calls, or gives you trouble during setup:

```
reticle_feedback { kind, text }
```

`kind` is one of `bug`, `gap`, `ambiguity`, `feature_request`, `improvement`. One call, then carry on with the task.

If the tools are unreachable (setup unfinished, daemon down), file the same report from the shell:

```bash
npx @reticlehq/server feedback --agent --kind <bug|gap|ambiguity|feature_request|improvement> "what happened"
```

Nothing is too minor. Report defects in **Reticle**; a bug you find in the app under test is Reticle working and belongs in your answer to the user. Never put app source, secrets, or user data in a report.

# References

- [references/setup.md](references/setup.md): per-framework SDK wiring, store registration, desktop apps.
- [references/verify.md](references/verify.md): the look, act, observe, assert loop and reading verdicts.
- [references/troubleshooting.md](references/troubleshooting.md): no session, port mismatch, non-localhost hosts, daemon problems.
