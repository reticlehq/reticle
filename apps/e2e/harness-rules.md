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

## Rule 1 — kill the listener, never the clients

```bash
lsof -ti tcp:4400 | xargs kill -9        # ✗ kills the daemon AND every attached MCP proxy
lsof -nP -iTCP:4400 -sTCP:LISTEN -t | xargs kill -9   # ✓
```

`reticle mcp` holds a **client** socket on the bridge port, so the unfiltered form lists it beside
the daemon. Measured: listener pid 70244 and proxy pid 70245 both returned; the kill took the proxy,
and every tool call after it hung unanswered with nothing in `~/.reticle/proxy-4400.log` — the
process that writes that log was the one that died.

Use `freePortSafely(port)`. It frees listeners first and only then looks at other holders, **naming
them before touching them**. That ordering also preserves the reason `run.mjs` originally skipped
`-sTCP:LISTEN`: a socket mid-teardown still holds the port and still causes `EADDRINUSE`, and it is
still reached — just second, once the listener is demonstrably gone.

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

## Rule 5 — sweep what the last run left behind

```js
await sweepBatteryOrphans(); // processes, by pattern. NOT ports.
```

A battery that exits normally runs its trap and cleans up. One that is **killed** — a CI timeout, a
Ctrl-C, an OOM — does not, and leaves a driven browser and an MCP proxy running. The next run
competes with them for the bridge port and for memory.

Measured, on this repo, by the person who wrote the four rules above: two killed runs left an
orphaned `cli.js mcp --drive` proxy driving a headless browser, the machine went to ~85MB free, and
the next battery came back **17 of 31** with four specs `killed by SIGKILL` and failures interleaved
with passes. Every one of those was read as a product regression first. After sweeping: **31 of 31**,
same commit, same code.

**Kill by process pattern; never by port.** `--drive` is the discriminator and it is load-bearing: a
bare `cli.js mcp` is somebody's **agent**, and killing that is rule 1's entire subject, while only the
battery starts a proxy with `--drive`. Ports get **named and left alone**.

That asymmetry is not fastidiousness. The first version of this rule also freed the ports it was
given — and `run-ci.sh` boots api:8787, bench-app:4310 and next-smoke:3100 **before** it runs
`run.mjs`, so the "orphans" the sweep found were the fixtures the battery had just started for
itself. It killed all three. **19 specs failed.**

From inside a run there is no way to tell "an orphan from a killed run" from "the server this run
started three seconds ago" — same command, same port, same user. A process *pattern* can be decided;
a port cannot. So the port half reports, and says plainly that a later bind failure will be that pid's
doing.

> Rules 1–4 were written by the same person who then broke rule 5 twice in one hour: once by leaving
> orphans behind, and once by writing a sweep that killed the run it was protecting. That is the
> argument for putting every rule in `gate-harness.mjs` rather than in prose — a rule you have to
> remember is a rule that gets skipped at exactly the moment you are busy chasing a failure. It is
> also the argument for the shape of this one: **a cleanup that cannot tell what it is deleting must
> report instead of delete.**

---

## Self-check

```bash
node apps/e2e/gate-harness.mjs --self-check
```

Stands up a listener and a client on one port in **separate processes** and asserts they are told
apart — `lsof -t` reports pids, not sockets, so a single process holding both ends collapses to one
pid and the distinction under test disappears. That is also why the real hazard only appears between
the daemon and the proxy, and why it went unnoticed.
