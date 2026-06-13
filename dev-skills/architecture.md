# dev-skills/architecture.md — Architecture & Contracts

**Open when:** adding a package, changing the wire contract, or making a structural call.
(Foundation II.9 + II.10.)

## The shape (full detail in `plan/02`)

```
agent ──MCP(stdio/http)──> @iris/server (bridge + MCP) ──WS──> @iris/browser (in the page)
                                  │
                                  └── per-session RingBuffer (look back + await forward)
```

The bridge exists because the agent speaks MCP in a terminal and the app is a browser tab —
they cannot talk directly. The **RingBuffer** is the core data structure: it lets `observe`
look backward at recent events and `wait_for` await forward ones.

## Contract-first

`@iris/protocol` is the single source of truth for every cross-boundary message. Change the
wire format **there** (constant + zod schema) before touching `browser` or `server`. The
schema is the contract; both sides validate against it. This is our version of contract
testing — if the two sides drift, schema parsing fails loudly.

## Dependency rules

- `protocol` depends on nothing (high-afferent, must stay stable).
- `browser` → `protocol` only. DOM-only, no Node APIs.
- `server` → `protocol` only. Node-only, no DOM APIs.
- `react` → `protocol`. Optional; core must work without it.
- `demo` → `browser` + `react`. Never the reverse.

Enforced by tsconfig project references. A new package picks a lane and respects these.

## Distributed-systems reflexes (they apply to the bridge)

- **The network is not reliable:** every command browser↔bridge has a timeout and a
  correlation id; a dropped reply must not hang the agent's MCP call.
- **Topology changes:** the browser reloads constantly (HMR). Sessions must survive
  reconnect; never key durable state on a socket identity.
- **Backpressure:** a busy SPA floods events. The RingBuffer is bounded; observers coalesce
  per frame. Never let an unbounded queue grow.

## Events vs direct calls

Browser→agent observations are an **event stream** (fire-and-buffer). Agent→browser
commands are **direct request/response** (the agent needs the result to proceed). Don't
blur these: a command that "fires and forgets" hides failures from the agent.
