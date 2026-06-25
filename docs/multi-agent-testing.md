# Multi-agent & multi-project testing

Iris is built for the messy real world: several apps running at once, ports that shift between runs,
and many agents driving different flows of the same app in parallel — without each one spinning up its
own Chromium. This page explains how that works and how to use it.

## The mental model

- **One daemon per machine.** `iris mcp` discovers a running daemon (via `~/.iris`) or starts one. A
  crashed daemon's stale pidfile is reclaimed automatically, so you never chase "port already in use"
  or a zombie server.
- **Identity is the app, not the port.** The build plugin stamps a stable `projectId` that travels in
  every connection. If your Next app usually runs on `:3000` but boots on `:3001` today, Iris still
  knows which app it is — and an agent scoped to project A will never accidentally drive project B's
  tab. Origin is only a fallback hint.
- **One browser, many contexts.** When agents need their own headless tabs, the daemon's **browser
  pool** launches a single Chromium and hands out isolated contexts (one per flow) — cheap, and capped
  so a big fan-out can't exhaust the machine. Over-cap requests queue.
- **Attach-only.** Iris never starts your dev server. It connects to an app you're already running
  (or opens a headless tab pointed at it).

## Manual testing — ~5 minutes

1. Add the plugin (Vite/Next) or one `iris.connect()` call. (See [getting-started](./getting-started.md).)
2. Start your app as you normally do.
3. Open it in a browser — the in-page panel shows Iris is connected.
4. Click around; flag anything that looks wrong with the "Flag a bug" annotator. The agent drains
   those with `iris_review`.

## Agent testing — ~2 minutes

With the app running and instrumented, an agent drives a flow end to end:

```text
iris_lease_acquire { url: "http://localhost:3000/dashboard" }
  → { sessionId: "lease-…", leased: 1, queued: 0 }
iris_act    { sessionId, ... }      # drive the flow
iris_assert { sessionId, ... }      # verify intent
iris_lease_release { sessionId }    # free the slot
```

`iris_lease_acquire` opens a fresh isolated headless context against your **already-running** app,
stamps the lease identity into the URL so the app's own SDK registers under a sessionId you can target,
and returns it. Release when the flow finishes.

## 10 agents, 10 flows, one dashboard

This is the design target, and it needs no special setup:

- Each agent calls `iris_lease_acquire` for the same dashboard URL → its own isolated context (own
  cookies/storage) in the **one** shared Chromium.
- The pool caps simultaneous contexts (`IRIS_MAX_CONTEXTS`, default scales with CPU under a ceiling);
  extra acquires queue and proceed as slots free.
- Flows can't bleed into each other — contexts are isolated and every session is scoped by `projectId`.
- If an agent crashes or hangs, its lease stops being touched and the **lease reaper** reclaims the
  context after a TTL, freeing the slot. One dead agent never starves the others.

`iris_sessions` lists everything with `projectId` (group by app) and `leased` (pool context vs a human
tab), so an orchestrator can see the whole fleet at a glance.

## Knobs

| Env                 | Default                        | Effect                                              |
| ------------------- | ------------------------------ | --------------------------------------------------- |
| `IRIS_MAX_CONTEXTS` | `min(8, cpus-1)`               | Max simultaneous leased headless contexts.          |
| `IRIS_PORT`         | from `.iris.json`, else `4400` | Daemon port (rarely needed — discovery handles it). |

## Why not just open many browsers?

Ten Chromiums is hundreds of MB each and will thrash a laptop. Ten contexts in one browser is a few MB
apiece and fully isolated — same correctness, a fraction of the cost. That's the whole point of the
pool.
