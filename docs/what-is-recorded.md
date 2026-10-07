---
title: What is recorded
description: What Reticle keeps on your machine, what is redacted, and what it takes for any of it to leave.
---

Reticle drives your app and reads what it did. That means it holds real content from real pages, so this page says exactly what it keeps, where it keeps it, and what it takes to make any of it leave.

If you read one line: **a verdict is entirely local and needs no account.** Nothing from your project is sent anywhere until you run `reticle login` and `reticle link`. Without them there is nowhere for it to go. (Anonymous usage counts, which carry nothing from your app, are separate and described in [Telemetry](telemetry.md).)

## On your machine

Everything lands in `.reticle/` in your project, and it is yours. Three kinds of thing:

|  | what it is | what is in it |
| --- | --- | --- |
| **runs** | a verdict and its evidence | what was claimed, whether it held, the request or state change that decided it, and the `file:line` of the element driven |
| **flows** | a journey you drove, saved so it can be replayed | the steps, the anchors they resolve by, and the values that were typed |
| **memory** | what this project has learned across sessions | intents you declared, envelopes of normal behaviour, notes about anchors that drift, the coverage ledger (`coverage.json`), the notes people pinned in the HUD (`notes.json`), and the user's latest request as the agent relayed it (`request.json`, local only) |

`.reticle/` splits into a part meant for git and a part meant to stay local. Flows are the part worth committing: a saved flow is a regression test. Evidence is the part that is not.

## What is redacted, and what is not

**Credential-shaped fields are redacted when a flow is saved.** A value typed into a field whose name looks like a secret is replaced with `<redacted: supply at replay>`, and replay reads the real value from `RETICLE_SECRET_<FIELD>` at run time. It keys off the field's name across every anchor kind (a testid, an accessible name, a signal), so an app without test ids is covered too.

**It is name-based, and that is the limit worth knowing.** It redacts a password. It does not redact a customer's name typed into a search box, because nothing about that field says "secret". A flow records the journey you actually drove.

So: **drive staging.** Not because the risk is large, but because it is real and avoiding it is free.

Network bodies are **not** captured by default. When you turn body capture on (`captureNetworkBodies: true`, or `VITE_RETICLE_CAPTURE_BODIES=1`), redaction runs **before each body is kept**. Built-in rules mask keys such as `password`, `apiKey` and `authorization`, selected token keys, and high-confidence secret shapes such as JWTs and `sk_live_…` keys. Other credential values can remain under names or in formats those rules do not recognize; add app-specific field names with `redact.keys` and use staging. Page content that reaches a verdict is the element text and attributes the assertion needed, not a copy of the DOM.

## What leaves, only if you ask

`reticle login` signs this machine in. `reticle link` binds one repo to one cloud project. Until both have happened, or `RETICLE_API_KEY` is set in the environment, `reticle push` has nothing to talk to and the sync path is a no-op. The code calls this the no-phone-home default. A key in the environment is how CI syncs with no login and no link, and it goes to the hosted service unless `RETICLE_CLOUD_URL` names another host.

Once linked, you choose what syncs:

```bash
npx @reticlehq/server config --runs on|off --flows on|off --memory on|off
```

`--memory` covers the coverage ledger and the HUD notes as well, and the notes are the words people typed. The user's request (`request.json`, the prompt the agent relayed, redacted) goes to the platform with the runs from a linked project, so the dashboard can show what each run was for; `"shareRequests": false` in `.reticle.json` keeps it on the machine. An unlinked project sends it nowhere, and it is kept out of git either way.

The Harness runs on the platform, so the platform sees what it drives: each step's result goes there so it can choose the next one. A secret field is sent by name only; its value is typed in on your machine.

**Drives asked for from the platform's chat.** While a linked project has an app connected, the daemon asks the platform every few seconds whether someone in your workspace asked its chat to drive this app. When they did, the daemon drives it here, on your machine, and sends back each step's result and how the drive ended, which the platform keeps as a check you can open in Runs. Unless the request said not to record, it also sends a picture of the tab it is driving, a JPEG about once a second, so the chat can show the drive live and replay it afterwards. The pictures are of the app as it looked, with Reticle's own panel left out; they are kept with that check (at most a few minutes' worth per drive) and deleted with the project. Only a tab the daemon opened itself can be pictured; a tab in your own browser sends steps only. Unlinking the project stops all of it.

## Telemetry, which is separate from all of the above

The CLI sends anonymous usage events: event names and a random installation id. No code, no page content, no URLs from your app. It is how we know which parts of the product are reached at all.

```bash
RETICLE_TELEMETRY=0          # this shell
DO_NOT_TRACK=1               # the convention, honoured
npx @reticlehq/server telemetry disable   # this machine, permanently
```

Telemetry carries no free text. Free text leaves in three ways, each one something you chose: a feedback report (never collected passively; `RETICLE_FEEDBACK=0` disables it), HUD notes on a linked project with `--memory on`, and the user's request from a linked project unless `"shareRequests": false`.

The daemon also fetches a small public file, `https://reticle.sh/hud/notices.v1.json`, for the notices in the HUD's rail. The request carries nothing about you or your project. `RETICLE_TELEMETRY=0` or `DO_NOT_TRACK=1` stops it, and `RETICLE_HUD_NOTICES_URL` points it elsewhere.

## What `init` writes to your project

Run it with `--dry-run` and it prints the whole plan without writing anything:

```bash
npx @reticlehq/server init --dry-run
```

`--app <dir>` picks which app in a monorepo. `--no-mcp` skips registering the MCP server with your agents and skips the agent rule files with it. `--files-only` writes the files and stops, without booting your dev server.
