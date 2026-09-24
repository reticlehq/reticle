---
title: What is recorded
description: What Reticle keeps on your machine, what is redacted, and what it takes for any of it to leave.
---

Reticle drives your app and reads what it did. That means it holds real content from real pages, so this page says exactly what it keeps, where it keeps it, and what it takes to make any of it leave.

If you read one line: **a verdict is entirely local and needs no account.** Nothing is sent anywhere until you run `reticle login` and `reticle link`. Without them there is nowhere for anything to go.

## On your machine

Everything lands in `.reticle/` in your project, and it is yours. Three kinds of thing:

|  | what it is | what is in it |
| --- | --- | --- |
| **runs** | a verdict and its evidence | what was claimed, whether it held, the request or state change that decided it, and the `file:line` of the element driven |
| **flows** | a journey you drove, saved so it can be replayed | the steps, the anchors they resolve by, and the values that were typed |
| **memory** | what this project has learned across sessions | intents you declared, envelopes of normal behaviour, notes about anchors that drift |

`.reticle/` splits into a part meant for git and a part meant to stay local. Flows are the part worth committing: a saved flow is a regression test. Evidence is the part that is not.

## What is redacted, and what is not

**Credential-shaped fields are redacted when a flow is saved.** A value typed into a field whose name looks like a secret is replaced with `<redacted: supply at replay>`, and replay reads the real value from `RETICLE_SECRET_<FIELD>` at run time. It keys off the field's name across every anchor kind (a testid, an accessible name, a signal), so an app without test ids is covered too.

**It is name-based, and that is the limit worth knowing.** It redacts a password. It does not redact a customer's name typed into a search box, because nothing about that field says "secret". A flow records the journey you actually drove.

So: **drive staging.** Not because the risk is large, but because it is real and avoiding it is free.

Network bodies are **not** captured by default. Page content that reaches a verdict is the element text and attributes the assertion needed, not a copy of the DOM.

## What leaves, only if you ask

`reticle login` signs this machine in. `reticle link` binds one repo to one cloud project. Until both have happened, `reticle push` has nothing to talk to and the sync path is a no-op. The code calls this the no-phone-home default.

Once linked, you choose what syncs:

```bash
npx @reticlehq/server config --runs on|off --flows on|off --memory on|off
```

## Telemetry, which is separate from all of the above

The CLI sends anonymous usage events: event names and a random installation id. No code, no page content, no URLs from your app. It is how we know which parts of the product are reached at all.

```bash
RETICLE_TELEMETRY=0          # this shell
DO_NOT_TRACK=1               # the convention, honoured
npx @reticlehq/server telemetry disable   # this machine, permanently
```

Feedback is the only free text that ever leaves, it is never collected passively, and `RETICLE_FEEDBACK=0` disables it.

## What `init` writes to your project

Run it with `--dry-run` and it prints the whole plan without writing anything:

```bash
npx @reticlehq/server init --dry-run
```

`--app <dir>` picks which app in a monorepo. `--no-mcp` skips registering the MCP server with your agents and skips the agent rule files with it. `--files-only` writes the files and stops, without booting your dev server.
