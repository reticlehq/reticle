# Reticle

Reticle embeds a dev-only SDK in the user's running app and exposes it to you as `reticle_*` MCP tools. You look, act, observe, and assert against the real app. No screenshots, and no browser download for the verify loop: it drives the tab the user already has open.

This file is the whole critical path and nothing else. Everything it leaves out is at `https://docs.reticle.sh`, one page at a time.

## Your first action, before you read the rest

Do not spend a turn working out which path you are on. The command knows.

```bash
RETICLE_INSTALL_SOURCE=skill_file npx @reticlehq/server@latest init --flow "<the journey worth proving>"
```

It is idempotent: on a project that is already wired it reports `·` for what is already there and goes straight to proving the app still works. Run it now, then read **SETUP** below for what to pass it and what to do with what it returns.

Everything between here and there is a rule the steps assume. Read it as you go, not before you act.

## Installed means a verdict was produced

**Setup is not complete until you have driven one real flow in the user's app and produced a verdict.** Writing config files is not installed. Every earlier point looks like success and is not:

- `init` exited 0. Files were written. Nothing connected.
- The `reticle_*` tools appeared. Your client can reach a daemon. The app is very likely still uninstrumented.
- A session is listed. The app dialled in. The user has still seen nothing happen.

**Do not tell the user Reticle is set up until a verdict exists.** The most common failure in the field is an agent that writes the config, reports success, and leaves somebody with an uninstrumented page. The command exits non-zero when that happens: believe the exit code over the report.

## Setup runs to the end without you

**Do not stop, and do not ask the user anything, until their app is running with Reticle inside it and a session is connected.** Everything between here and that point is yours to do: run `init`, fix the wiring it could not, start the dev server, open the browser. Not one of those needs a human, and every one of them has been the place an onboarding turn died with nothing to show.

Questions you must not ask, because the repo you are sitting in already answers them: which framework, which package manager, which port, which editor or MCP client, whether to start the dev server, whether to open the browser, whether to carry on. Decide, act, and say what you did in one line.

There are exactly three places you may stop, and none is a question about a preference:

1. **No recognisable dev script in `package.json`.** Say so; do not invent one.
2. **Your host asks the human to approve a command.** That prompt belongs to the host. Never bypass or suppress it, and take a refusal as the answer. `init` writing a pre-approval rule for the `reticle` server is not that: it is a scoped, announced config change the human asked for by running the command, and it covers only Reticle's own tools.
3. **Only if no agent CLI exists on the machine at all**, the client restart that loads the MCP tools (step 2). If `claude`, `codex`, `cursor-agent` or `gemini` is installed, you do NOT stop. Step 2 shows you how to drive from a child process instead, and that path is measured to be the difference between a verdict and a dead end.

If you do have to stop, the restart ends your turn. This file was fetched into the context that just ended, so nothing carries it across unless you make it. **Before you trigger the restart, write the remaining steps into `RETICLE-SETUP.md` at the repo root**, one line each, with the step you stopped at marked. That file is what you re-read afterwards. Delete it once step 5 has produced a verdict.

Better still, install the on-disk copy first. It survives the restart on its own, and it is the same content:

```bash
npx skills add reticlehq/reticle --skill install-and-verify -y
```

**After the restart, resume at the step you were on.** Do not start over, and do not skip forward.

## Feedback is first-class

Reticle is built for agents. You are its user, and your experience is the only signal that decides what gets built or fixed. It disappears when your context does.

The moment Reticle breaks, lies, cannot see something you needed, costs too many calls, or gives you trouble during setup:

```
reticle_feedback { kind, text }
```

`kind` is one of `bug`, `gap`, `ambiguity`, `feature_request`, `improvement`. One call, then carry on with the task. If the tools are unreachable (setup unfinished, daemon down), file the same report from the shell:

```bash
npx @reticlehq/server feedback --agent --kind <bug|gap|ambiguity|feature_request|improvement> "what happened"
```

Nothing is too minor. Report defects in **Reticle**; a bug you find in the app under test is Reticle working, and belongs in your answer to the user. Never put app source, secrets, or user data in a report.

## Do not re-read this file to look something up

Fetch the one page that answers the question instead. **Appending `.md` to any docs URL returns its source with no site chrome.**

```bash
curl https://docs.reticle.sh/llms.txt              # every page title and URL; read this first
curl https://docs.reticle.sh/frameworks.md         # per-framework SDK wiring
curl https://docs.reticle.sh/troubleshooting.md    # nothing connected, click did nothing, verdict unknown
curl https://docs.reticle.sh/agent-cheatsheet.md   # the verify loop on one screen
```

Every page arrives with the rules that matter prepended, so a single fetch orients you without a second call.

## Which path am I on

You do not have to decide. `init` is idempotent and reports what is already wired, so running it is the cheapest way to find out, and on an installed project it goes straight to proving the app still works.

Read **VERIFY** below when the question is "does this still work?" rather than "is this set up?". If `reticle_sessions` returns an empty list on a project that is already wired, fetch `https://docs.reticle.sh/troubleshooting.md`; do not restart setup.

---

# SETUP

Read **[Setting Reticle up](https://docs.reticle.sh/skill-setup)**. It also ships on disk beside this file, at `docs/skill-setup.md`, so you can open it without a network call.

That page covers what to pass `reticle init`, how to read the report it gives back, what to do when it cannot finish the job on its own, who starts the dev server, and license keys.

You need it once, while setting a project up. If `reticle_sessions` already lists a session, skip straight to **VERIFY** below and never open it.

# VERIFY

**Only `reticle_act_and_wait` and `reticle_assert` produce a verdict.** Everything else (`act`, `snapshot`, `query`, `navigate`, `observe`, `network`, `console`) moves or reads the app and proves nothing. A drive that ends without one of those two has no result, however many tools it used.

A verdict of `verified: "unknown"` is not a pass. It means Reticle drove the app and could not tell what happened. Report it as unknown. `verified: "no-fault"` is not a pass either. It means the page settled and no channel reported a problem, but nothing was declared to prove, so assert a consequence the action CHANGES. **Never weaken a check to make it pass.**

## Take the cheapest path that answers the question

Work down this list and stop at the first row that fits. Do not hand-drive a flow you could replay, and never pay one call per field.

| The question | The call | Calls |
| --- | --- | --- |
| "Did my edit break anything?" | `reticle_verify({ action: "change", files: ["src/App.tsx"] })` | 1 |
| "Does this known journey still work?" | `reticle_run({ tool: "reticle_flow_replay", args: { flowName: "login" } })` | 1 |
| "Does this new behaviour work?" | `reticle_act_sequence` for the setup, then ONE `reticle_act_and_wait` | 2 |
| No MCP available at all | `npx @reticlehq/server verify <url>` in the shell | 1, no MCP |

`reticle_verify` and `reticle_flow_replay` are **not on the advertised tool list**: they are reached through `reticle_run` exactly as written above. That is the supported call shape, not a workaround, and it is why you have to be told they exist at all.

`reticle_verify {action:"change"}` answers `unknown` when no saved flow covers the files you changed. That is the honest answer and not a failure. Nothing ran, so nothing was proved. It is also the signal to record one. Never read it as a pass.

## Two more you have to be told about

Same story as `reticle_verify`: extended surface, so they are not in the tool list you were handed, and reached through `reticle_run`.

**Context compacted, a turn starting, or a sub-agent taking over?** Ask what this run already established, instead of re-snapshotting to rediscover what you already knew:

```
reticle_run({ tool: "reticle_context", args: {} })
```

**About to change something?** Declare what the change is SUPPOSED to make true, in prose, while you still know. A verdict with nothing declared can only be checked against itself:

```
reticle_run({ tool: "reticle_intent", args: { action: "declare", intents: [{ id: "checkin", statement: "clicking Send check-in makes the badge read 'checked in'" }] } })
```

Or say it on the verdict itself and skip the round trip. `reticle_act_and_wait` and `reticle_assert` both take an optional `intent`, writing the same ledger:

```
reticle_act_and_wait({ ref: "e42", action: "click", until: { kind: "signal", name: "checkin:sent" }, intent: "clicking Send check-in makes the badge read 'checked in'" })
```

The verdict that passes is the one that proves it. Already declared it? Pass the intent's **id** there instead of the prose, and several verdicts can answer to one statement.

## Record once, replay cheaply

The first drive of a journey is expensive. The rest should not be. After you drive something worth keeping:

```
reticle_run({ tool: "reticle_record", args: { action: "start", recordingName: "checkout" } })
   ... drive the flow ...
reticle_run({ tool: "reticle_record", args: { action: "stop",  recordingName: "checkout" } })
reticle_run({ tool: "reticle_flow_save", args: { flowName: "checkout" } })
```

From then on that journey re-verifies in one call, deterministically, and `reticle_verify {action:"change"}` can start answering `yes` or `no` for the files it touches instead of `unknown`.

Check `assertions.grade` on the save. Anything other than `asserted` means the flow only acts, so it will pass even if the feature breaks.

## When you do have to drive by hand

Five calls, and the last one is the only one that counts:

```
reticle_sessions()                                   // connected? if empty, read `why` — it names the fix
reticle_run({ tool: "reticle_capabilities", args: { sessionId } })  // the app's whole testable surface, ~1 KB
reticle_snapshot({ sessionId, mode: "interactive" }) // just the controls, with refs
reticle_act_and_wait({ sessionId, ref, action: "click", until: { kind: "allOf", predicates: [
  { kind: "net",     urlContains: "/api/...", status: 200 },
  { kind: "element", query: { testid: "..." } },
  { kind: "console", level: "error", absent: true },
]}})                                                 // ← the verdict
```

Prefer `reticle_act_and_wait({ ref, action, until })`. It names the expected consequence **before** the action, which is the difference between a check and a rationalisation.

A verdict of `verified: "unknown"` is not a pass. It means Reticle drove the app and could not tell what happened. Report it as unknown. `verified: "no-fault"` is not a pass either. It means the page settled and no channel reported a problem, but nothing was declared to prove, so assert a consequence the action CHANGES. **Never weaken a check to make it pass.**

Then report what you drove, what it produced, and the `file:line` for anything broken.

The surface is deliberately small: `default` 19, `all` 30. Editors budget tools across every MCP server you have connected (Cursor allows 40 in total), so the count is capped rather than allowed to grow. `reticle_tools` loads the argument grammar for the rest on demand, and `reticle_run` invokes any of them by name. Nothing is unreachable; the cold tail just costs one discovery hop.

- Batching, regression suites, reading a verdict: `https://docs.reticle.sh/agent-cheatsheet.md`
- Every predicate and action: `https://docs.reticle.sh/predicates.md`, `https://docs.reticle.sh/actions.md`
- The complete tool surface: `https://docs.reticle.sh/usage.md`
