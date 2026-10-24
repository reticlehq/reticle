---
title: Prompt capture
description: How Reticle keeps each prompt you send, where it goes, and every way to turn it off.
---

A verdict is checked against what the user asked for. An agent tells Reticle the request only when it remembers to, so `reticle init` installs a hook that hands over each prompt before the agent reads it.

## What `init` installs

`reticle init` adds a prompt-submit hook to the project-level config of each agent it finds that has one:

| Agent | Config file |
| --- | --- |
| Claude Code | `.claude/settings.json` |
| Cursor | `.cursor/hooks.json` |
| Codex CLI | `.codex/hooks.json` |
| Gemini CLI | `.gemini/settings.json` |
| Windsurf | `.windsurf/hooks.json`, or `.devin/hooks.json` when it is there |
| VS Code Copilot and Copilot CLI | `.github/hooks/reticle-prompt-capture.json` |
| Factory Droid | `.factory/hooks.json` |

Each hook runs `npx -y @reticlehq/server@<version> hook prompt --agent <id>`. The version is pinned to the one that ran `init`. Run `init` or `reticle hook install` again after an upgrade to move the pin. These files are in your repository, so a teammate who commits them shares the hook. Codex runs a project hook only after you trust the project's `.codex/` folder.

Agents with no prompt hook, such as Claude Desktop, get an instruction in the MCP server's instructions: declare the request with `reticle_intent` once for each user request.

## What it writes

The hook writes two files in the project's `.reticle/` folder:

| File | What is in it |
| --- | --- |
| `request.json` | the newest prompt, split into statements and classified |
| `requests.jsonl` | every prompt, one JSON line each, oldest first. At 2 MB it moves to `requests.1.jsonl` |

Secrets are removed before anything is written: credential assignments (`password: …`, `STRIPE_SECRET_KEY=…`), vendor keys (`sk_live_…`, `ghp_…`, `AKIA…`, `AIza…`, `glpat-…`, `xoxb-…`), JWTs, emails, card numbers, phone numbers, home paths and hostnames. This is a pattern match, not a proof: a secret that looks like an ordinary word stays. A prompt is capped at 20,000 characters.

`request.json`, `requests.jsonl` and `requests.1.jsonl` are in `.reticle/.gitignore`. Reticle adds them to an older ignore file that does not have them, and keeps every line you wrote.

The hook makes no network call of its own and never blocks a prompt: a failure is exit 0 and nothing written. `npx` downloads the pinned version once when its cache does not have it. Nothing about a prompt reaches telemetry.

## What leaves the machine

**Requests are shared by default for a linked project.** A project is linked by `reticle connect` (`.reticle/cloud.json`) or by `RETICLE_API_KEY` in the environment. A run written soon after a prompt carries that prompt, and the run goes to your own workspace when it syncs. The Harness also sends the newest request to the platform planner as a goal. An unlinked project sends the request nowhere.

To keep requests on the machine, set `"shareRequests": false` in `.reticle.json`. Capture goes on, and nothing about a request leaves: not with a run, and not to the Harness.

A run syncs through `reticle sync`, through the daemon's background sync, or when `reticle verify` closes in CI. Background sync runs only for a project linked by its own `cloud.json`, and only while somebody is signed in to that address or `RETICLE_API_KEY` is the key for that link.

## Turn it off

| What                                 | How                                          |
| ------------------------------------ | -------------------------------------------- |
| Do not install the hook              | `reticle init --no-prompt-capture`           |
| Stop capture in one project          | `"promptCapture": false` in `.reticle.json`  |
| Stop capture on this machine         | `RETICLE_PROMPT_CAPTURE=0`                   |
| Keep requests local                  | `"shareRequests": false` in `.reticle.json`  |
| Stop background sync in one project  | `"backgroundSync": false` in `.reticle.json` |
| Stop background sync on this machine | `RETICLE_BACKGROUND_SYNC=0`                  |
| Remove the hook                      | `reticle hook uninstall`                     |

## `reticle hook`

```bash
npx @reticlehq/server hook status      # per agent: is each prompt captured here
npx @reticlehq/server hook install     # add the hook for the agents this project uses
npx @reticlehq/server hook uninstall   # remove exactly what was added
```

`hook install` writes a config only for an agent this project already uses (its folder is in the project, or the Claude Code CLI is on this machine). `hook prompt --agent <id>` is what the agent's hook runs; you do not run it yourself. `reticle doctor` prints the same rows as `hook status`, and whether background sync is on.
