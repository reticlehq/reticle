# Harness rules

> Five rules every gate, battery and benchmark in this repo must follow. They are enforced by
> [`gate-harness.mjs`](./gate-harness.mjs); this page is why they exist.

**The harness is a client of the system it measures.** It speaks the same MCP proxy, the same
daemon, the same bridge as a real agent, and it inherits every failure mode listed in
[`docs/system-map.md`](../../docs/system-map.md). When it inherits one silently, the result is not a
missing measurement — it is a **confident wrong one**, filed against the product.

That is not hypothetical. Every unreliable gate result in this repo traces to it:

| What was reported | What had actually happened |
| --- | --- |
| "SvelteKit: app booted but NO session appeared" | the daemon had died 21 seconds earlier; `astro` connected fine right afterwards as the control |
| three fixtures failed to connect | the daemon's own idle shutdown fired during a long `pnpm install` |
| "the MCP link never recovers — 40s, no reply, twice" | the harness had killed its own proxy with `lsof -ti tcp:4400 \| xargs kill -9` |
| "`reticle_run` silently drops `sessionId`, 6 of 6 apps" | true when filed, fixed since — and re-filed as still-broken a week later because a stale session made it look identical |

Four of four were harness artifacts presented as product defects. Two of them cost a full
investigation each.

---

## Rule 1 — stop only processes this run owns

A listener on a test port may be a developer's daemon. A connected socket may be the agent's
MCP transport. Neither the port nor a matching command line establishes ownership.

`freePortSafely(port, { ownedPids })` only stops listeners whose PIDs the caller recorded when
starting them. It refuses an unrelated listener and leaves connected clients alone. Without
`ownedPids`, an occupied port is an error, not permission to kill its owner.

The web and desktop batteries default to bridge port `14400`; set `RETICLE_PORT` to choose
another test port. Each launcher creates private daemon state and a pairing token. The runner
can reap its detached daemons from that run's PID files without touching the developer's daemon.

## Rule 2 — own the daemon for the whole run

```js
const daemon = await startOwnedDaemon(PORT, { cliPath });
```

Two things this prevents:

- **The daemon exits underneath you.** Idle shutdown is 5 minutes (30 with an agent attached), and
  `isUselessDaemon` will end a daemon that has never served a tool call regardless. A gate that
  spends six minutes installing before its first call is exactly that daemon. `startOwnedDaemon`
  sets `RETICLE_IDLE_SHUTDOWN_MS=0`.
- **A daemon spawned implicitly is reaped.** One started inside an agent's shell command receives
  `SIGTERM` within a second of that command finishing, `detached` or not. Never let a tool call be
  the thing that starts your daemon.

It also waits for a real **bind**, not a spawn: `reticle serve` logs `reticle_daemon_spawned` and
exits 0 while the child dies on `EADDRINUSE` (issue #115). `/status` answering is the only honest
signal that a daemon exists.

## Rule 3 — one MCP connection, held open for the whole run

A connection per call hides exactly the failures worth catching: reconnect storms, dormancy, the
handshake replay, stale tool catalogs, and every outage that only shows up on a link that has been
alive long enough to lose. A 9-app sweep on one held-open connection recorded 122 calls in 193
seconds with zero outage events — a baseline that means something. The same sweep on fresh
connections would have measured nothing at all.

## Rule 4 — never attribute a failure the transport could explain

```js
const watch = watchTransport(PORT);
// … boot the app, wait for a session …
const { aliveThroughout } = watch.stop();
const { outcome, because } = attributeOutcome({ connected, transportAliveThroughout: aliveThroughout });
```

Three outcomes, not two. A fixture that never got a bridge was **never tested**, and reporting that
as a failure is how a correct SvelteKit install became a bug report. `INCONCLUSIVE` names the
transport and asks for a re-run.

This mirrors the rule the product itself follows — `decideVerified` returns `UNKNOWN` rather than
`NO` whenever the evidence is absent rather than negative, because "reporting a failure we did not
observe would be its own false claim". The harness does not get an exemption from its own product's
standard of honesty.

## Rule 5 — clean up recorded children, report everything else

Stop the process groups or trees created by the run, including fixture wrappers and their
children. `stopProcessTree(pid)` walks only descendants of a recorded child PID. The runner
cleans each spec's process group and its own detached daemon before continuing.

`sweepBatteryOrphans(ports)` reports occupied ports. It never kills a process because its
command resembles a test: a developer can run the same command. An interrupted run may leave
a process behind; identify that process or choose another port rather than killing by pattern.


---

## Self-check

```bash
node apps/e2e/gate-harness.mjs --self-check
```

Stands up a listener and a client on one port in **separate processes** and asserts they are told
apart — `lsof -t` reports pids, not sockets, so a single process holding both ends collapses to one
pid and the distinction under test disappears. That is also why the real hazard only appears between
the daemon and the proxy, and why it went unnoticed.
