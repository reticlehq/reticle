---
title: Debugging Reticle
description: For people working on Reticle itself. How to work out why a flow behaved the way it did.
icon: bug
---

**To debug Reticle itself, start with the daemon log at `~/.reticle/daemon-<port>.log`, and turn on `RETICLE_TRACE=1` for the daemon when you need per-stage timings.** `reticle doctor` prints the exact log path for your port. Reticle produces four distinct signals and they answer four different questions, so the first step is picking the right one.

> For people working **on** Reticle, and for an agent asked to explain why a flow behaved the way it did. If you are debugging **your app** with Reticle, you want [usage.md](usage.md) instead.

Reticle produces four different signals and they answer four different questions. Reaching for the wrong one is why investigations here have historically started by reading source.

| Question | Signal | Where |
| --- | --- | --- |
| What did the **agent** do to the app, and what did the app do back? | the journal | `reticle_observe` (the event window), `reticle_run_export` (a saved run), `~/.reticle/journal/` |
| What did **Reticle** do internally to answer that call? | the **trace** | daemon log, with `RETICLE_TRACE=1` |
| What happened at a milestone (daemon start, skew, refusal)? | structured log lines | daemon log |
| How much is this being used, and does it work? | telemetry | [telemetry.md](telemetry.md) |

## The daemon log

The daemon writes newline-delimited JSON to:

```
~/.reticle/daemon-<port>.log        # or $RETICLE_STATE_DIR/daemon-<port>.log
```

`reticle doctor` prints the exact path for your port. Tail it while you work:

```bash
tail -f ~/.reticle/daemon-4400.log | jq .
```

## Verbose flow tracing

Off by default, because a trace on every tool call is a cost on the hot path, and a verification loop is 50 to 200 calls. Measured, so the claim is checkable: a disabled span costs **126ns** per site (against ~9ns for a bare call), which is under a microsecond per tool call and not the literal zero it is tempting to write. Turn it on **for the daemon** (the flag is read per call, but the daemon is the process doing the work, so it has to be set where the daemon starts):

```bash
RETICLE_TRACE=1 reticle serve --port 4400
```

Every instrumented stage then emits one line **when it ends**, carrying its own duration:

```jsonl
{"event":"trace","span":"browser.command","ms":412,"depth":1,"callId":"p8123-c7","ok":true,"command":"act"}
{"event":"trace","span":"tool.handler","ms":430,"depth":0,"callId":"p8123-c7","ok":true,"tool":"reticle_act"}
```

Read it like this:

- **`callId`** groups every stage of one tool call, and is prefixed with the daemon's pid so two daemons (or one that restarted) can never claim the same id. Several agents can be inside the daemon at once, so lines interleave; the id is the only thing that makes the output a tree instead of a pile.
- **`depth`** is the nesting level. `0` is the tool handler; anything deeper ran inside it.
- **`ms`** is that stage's own wall-clock. A parent's `ms` includes its children's.
- **`ok:false`** carries an `error` field. A stage that threw is still traced; otherwise the trace would show a call that entered a stage and never left, which reads as a hang.

One line per stage, at the end, is deliberate: a start line as well would double the volume to say something the end line already implies.

### Where the time goes

The spans that ship today:

| Span | What it covers |
| --- | --- |
| `tool.handler` | the whole tool call, at the one dispatch point both MCP and programmatic callers pass through |
| `browser.command` | one round-trip to the page |
| `flow.step` | one step of a replayed flow, with its anchor kind |
| `crawl.step` | one control the crawl clicked, including its settle budget |
| `init.plan` / `init.apply` / `init.exec` / `init.exec.retry` / `init.write` | the install, phase by phase |

The first two answer _"is this slow because of us or because of the app under test?"_

`browser.command` close to `tool.handler` means the app is taking the time. A large gap between them is Reticle's own overhead, and that is a performance bug of ours.

Filter to one call:

```bash
grep '"event":"trace"' ~/.reticle/daemon-4400.log | jq -c 'select(.callId=="p8123-c7")'
```

Or find the slowest stages across a session:

```bash
grep '"event":"trace"' ~/.reticle/daemon-4400.log | jq -sc 'sort_by(-.ms)[:10] | .[] | {span,ms,tool}'
```

### The init flow

`reticle init` is synchronous end to end, so it uses `spanSync`: same line, same tree:

```
init.plan        2ms
init.exec       133ms  target=package.json command=pnpm
init.exec.retry 128ms  target=package.json command=pnpm
init.write        1ms  target=.reticle.json
init.apply      262ms  steps=5
```

Two things that trace makes visible and nothing else did. Planning is ~2ms, so init's wall-clock is essentially all subprocess: the package manager, and `claude mcp add` when MCP registration is on. And when the pinned install is refused, the unpinned **retry is a second full package-manager run**, so init legitimately takes about twice as long on that path. Every `--local` fixture run takes it, because the version being installed is not published yet.

### Adding a span

```ts
import { span } from '../trace.js';

const result = await span('predicate.eval', { kind: predicate.kind }, () => evaluate(predicate));
```

Wrap a stage worth a line in a bottleneck hunt: a session resolve, a browser round-trip, a predicate evaluation. Not every function: the trace earns its keep by being faster to read than the code, and that stops being true somewhere around one line per statement. Nesting needs no plumbing: the call id and depth ride in `AsyncLocalStorage`, so a span added five frames down still lands in the right tree without changing anyone's signature.
