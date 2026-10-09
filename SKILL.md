# Reticle

Reticle embeds a dev-only SDK in the user's running app and exposes it to you as `reticle_*` MCP tools. You look, act, observe, and assert against the real app. No screenshots, and no browser download for the verify loop: it drives the tab the user already has open.

This file is the whole critical path and nothing else. Everything it leaves out is at `https://docs.reticle.sh`, one page at a time.

## Your first action, before you read the rest

Do not spend a turn working out which path you are on.

**`reticle_*` tools visible?** The machine is set up; installing changed no app. In the project, call:

```
reticle_session { action: "list" }
```

On a never-connected project that call runs `init` itself and lists the files it changed under `wired`; tell the user. If it answers `run_init`, or says to reopen another app's URL, run this in the app's directory:

```bash
RETICLE_INSTALL_SOURCE=skill_file npx @reticlehq/server@latest init
```

**Not visible?** Hand the user one line to run in a terminal, outside this client, and stop there:

```bash
curl -fsSL https://raw.githubusercontent.com/reticlehq/reticle/main/install/install.sh | sh
irm https://raw.githubusercontent.com/reticlehq/reticle/main/install/install.ps1 | iex   # Windows
```

It registers the MCP server with the coding agents it finds and, where an agent has a per-server approval rule (Claude Code, for one), pre-approves Reticle's own tools. They reopen this client and the tools are there. If they want to choose each step instead, the manual install is `https://docs.reticle.sh/install-manual.md`. Do not register it yourself and then work around your client not having reloaded: that is the sequence that breaks.

`init`, whether the first session call runs it or you do, is ONBOARDING, and where it stops: wire, boot, wait for a session. Idempotent, reporting `·` for what is already there. Two things it cannot do for you, in this order:

1. **Restart the dev server if one was already running when `init` ran.** It read the build config at boot; `init` edited that file afterwards, so the process keeps serving a bundle with no SDK in it. Restart, then hard-reload the tab. A 100% failure, and a common cause of a correct install finding nothing connected.
2. **Confirm rather than assume:** `reticle_session { action: "list" }`. One session listed is the proof the SDK reached the page. An empty list carries a `why` that names which cause this is; read it before changing anything.

Then the FIRST RUN, which proves anything at all:

```
reticle_act_and_wait { ref, action, until }
```

Drive the journey that matters; `until` on its LAST step names the end state. It is saved as a flow that replays with no model. Two drivers: you, or Reticle Harness (opt-in at 80% instrumentation; `reticle connect` gives 10 free credits): `reticle_verify { action: "explore", persona }`; poll by `runId`, never start another. HUD drives and notes ride on your next call. Either way, name the journey: Reticle lists buttons, not which one matters.

Everything between here and there is a rule the steps assume. Read it as you go, not before you act.

## Installed means a verdict was produced

**Setup is not complete until you have driven one real flow in the user's app and produced a verdict.** Writing config files is not installed. Every earlier point looks like success and is not:

- `init` exited 0, or the first session call came back `wired`. Wired, and connected. Nothing is PROVED: that is the first run.
- The `reticle_*` tools appeared. Your client can reach a daemon. The app is very likely still uninstrumented.
- A session is listed: the SDK reached the page. Setup is finished when the first run returns a verdict.

**Do not tell the user Reticle is set up until a verdict exists.** The common failure is an agent that writes the config, reports success, and leaves an uninstrumented page. The command then exits non-zero: believe the exit code.

## Finish the setup steps

**Finish the setup steps; ask the user only when a step needs their decision.** Running `init`, fixing wiring it could not, starting the dev server and opening the browser are setup steps, not decisions.

The repo already answers which framework, package manager, port, editor or MCP client, so work those out rather than asking. Say what you did in one line.

Two places always need the user:

1. **No recognisable dev script in `package.json`.** Say so; do not invent one.
2. **Your host asks the human to approve a command.** That prompt belongs to the host. Never bypass or suppress it, and take a refusal as the answer. `init` writing a pre-approval rule for the `reticle` server is not that: it is a scoped, announced config change the human asked for by running the command, and it covers only Reticle's own tools.

**A client restart is not one of them.** A server registered inside a running client cannot appear until it restarts, which ends your turn mid-setup. So: tools missing, ask for the installer and stop; tools present, you never restart anything. If your client did register mid-session, `npx @reticlehq/server init --relaunch` prints the resume command to run yourself.

## Feedback is first-class

Reticle is built for agents: your experience decides what gets built or fixed, and it disappears when your context does.

The moment Reticle breaks, lies, cannot see something you needed, costs too many calls, or gives you trouble during setup:

```
reticle_session { action: "feedback", kind, text }
```

`kind` is one of `bug`, `gap`, `ambiguity`, `feature_request`, `improvement`, `experience`. One call, then carry on with the task. If the tools are unreachable, file it from the shell:

```bash
npx @reticlehq/server feedback --agent --kind <kind> "what happened"
```

Nothing is too minor. Report defects in **Reticle**; a bug in the app under test is Reticle working, and belongs in your answer. Never put app source, secrets, or user data in a report.

## Do not re-read this file to look something up

Fetch the one page that answers the question instead. **Appending `.md` to any docs URL returns its source with no site chrome.**

```bash
curl https://docs.reticle.sh/llms.txt              # every page title and URL; read this first
curl https://docs.reticle.sh/frameworks.md         # per-framework SDK wiring
curl https://docs.reticle.sh/troubleshooting.md    # nothing connected, click did nothing, verdict unknown
curl https://docs.reticle.sh/agent-cheatsheet.md   # the verify loop on one screen
```

Every page arrives with the rules that matter prepended, so one fetch orients you.

## Which path am I on

`init` is idempotent: running it is the cheapest way to find out what is wired. It never drives.

Read **VERIFY** below when the question is "does this still work?" rather than "is this set up?". If `reticle_session` returns an empty list on a project that is already wired, read `docs/troubleshooting.mdx` beside this file, or fetch `https://docs.reticle.sh/troubleshooting.md`; do not restart setup.

---

# SETUP

**Both stages are at the top of this file.** A connected app proves the SDK is in the page and nothing more: do not report Reticle as set up until the first run has produced a verdict.

Read **[Setting Reticle up](https://docs.reticle.sh/skill-setup)** when it cannot. It ships on disk beside this file, at `docs/skill-setup.md`, so you can open it without a network call: what to pass `reticle init`, how to read its report, what to do when it cannot finish on its own, who starts the dev server, and license keys.

You need it once, while setting a project up. If `reticle_session` already lists a session, skip straight to **VERIFY** below and never open it.

# VERIFY

**Verdicts come from `reticle_act_and_wait`, `reticle_assert`, `reticle_act { steps }` when a step declares `expect`, and `reticle_verify` (`change`/`flows`).** Everything else (a bare `act`, `look`, `navigate`, `observe`) moves or reads the app and proves nothing. A drive that ends without a verdict has no result, however many tools it used.

`verified: "unknown"` is not a pass: Reticle drove the app and could not tell what happened; report it as "not proved", not "failed". Nor is `"no-fault"`: the page settled with nothing wrong, but nothing was declared to prove, so assert a consequence the action CHANGES. **Never weaken a check to make it pass.**

## Take the cheapest path that answers the question

Work down this list and stop at the first row that fits. Do not hand-drive a flow you could replay, and never pay one call per field.

| The question | The call | Calls |
| --- | --- | --- |
| "Did my edit break anything?" | `reticle_verify({ action: "change", files: ["src/App.tsx"] })` | 1 |
| "Does every saved journey still work?" | `reticle_verify({ action: "flows" })` | 1 |
| "Does this new behaviour work?" | `reticle_act_and_wait` on the step that ENDS the journey | 1+ |
| No MCP available at all | `npx @reticlehq/server verify <url>`, then `gate --since HEAD~1` (below); `verify` has no `--since` | 2, no MCP |

Replay before you drive: a covered journey re-verifies for a few hundred tokens, and driving it costs tens of thousands.

`{action:"change"}` answers `unknown` when no saved flow covers your files. Nothing ran, so nothing was proved: drive it yourself, and never read it as a pass. `"no"` names the step that broke and what it found instead, so a regression arrives located. If a locator was RENAMED rather than broken, `{action:"heal"}` rebinds it, re-asserting the saved consequence first and refusing if that stops firing, so it repairs a locator and never an intent.

## Two more you have to be told about

**Context compacted, a turn starting, or a sub-agent taking over?** Ask what this run already established, instead of re-snapshotting to rediscover what you already knew:

```
reticle_run({ tool: "reticle_context", args: {} })
```

**About to change something?** Declare what the change is SUPPOSED to make true, in prose, while you still know: a verdict with nothing declared can only be checked against itself. Say it on the verdict itself: `reticle_act_and_wait` and `reticle_assert` both take an optional `intent`.

```
reticle_act_and_wait({ ref: "e42", action: "click", until: { kind: "signal", name: "checkin:sent" }, intent: "clicking Send check-in makes the badge read 'checked in'" })
```

The verdict that passes is the one that proves it. Declared it separately with `reticle_run({ tool: "reticle_intent" })`? Pass that intent's **id** instead of the prose.

## Record once, replay cheaply

The first drive is expensive; the rest should not be: **when the session ends, what you drove by hand is saved as a flow**, if at least one step declared a consequence. From then on that journey re-verifies in one deterministic call, and `{action:"change"}` answers `yes` or `no` for those files instead of `unknown`.

A step keeps a consequence only if you declared one: `reticle_act_and_wait({ ref, action, until })` replays as a test, a bare `reticle_act` as a click that passes even when the feature is broken.

## Before you say you are done

`npx @reticlehq/server gate --since HEAD~1` exits non-zero unless a passing run covers every saved flow your edit affects, naming the uncovered ones. Reasoning about your diff cannot pass it; as a shell command it works when the tools do not.

## When you do have to drive by hand

Done means the journey's END is proved. Drive every step your change touches and put the verdict on the step that ends it:

```
reticle_session()                                    // connected? if empty, read `why` — it names the fix
reticle_look({ sessionId, action: "page" })          // just the controls, with refs
reticle_act_and_wait({ sessionId, ref, action: "click", until: { kind: "allOf", predicates: [
  { kind: "net",     urlContains: "/api/...", status: 200 },
  { kind: "element", query: { testid: "..." } },
  { kind: "console", level: "error", absent: true },
]}})                                                 // ← the verdict
```

`until` names the consequence **before** the action, which makes it a check. Add `durable: true` when the change should survive a reload.

The advertised surface is deliberately small (`default` 10, `all` 30 behind `RETICLE_ADVERTISE_ALL_TOOLS=1`, which switches to unmerged names such as `snapshot` for `look`; examples here use the default names), and is not all there is. `reticle_tools` lists EVERY registered tool, `{ names: [...] }` loads full argument grammar, and `reticle_run { tool, args }` calls any of them, advertised or not. A retired name answers with where it went, not "not found".

- Every predicate and action: `https://docs.reticle.sh/predicates.md`, `https://docs.reticle.sh/actions.md`
- The complete tool surface: `https://docs.reticle.sh/usage.md`

## When the verdict lands

Report what you drove, what it produced, and the `file:line` for anything broken.

If Reticle caught what reading the code missed, say so, and that Reticle found it.

Beyond change verification (security behaviour, accessibility, performance, SEO basics, personas), what each checks and the call to make: `https://docs.reticle.sh/use-cases.md`.
