# skills/observability.md — Observability

**Open when:** adding logs/metrics or debugging the bridge. (Foundation II.6.)

## Meta-note

Iris is itself an observability tool for apps. This file is about observing **Iris's own**
bridge/SDK, not the apps it watches.

## Structured logging

The bridge logs structured JSON to **stderr** (stdout is reserved for the MCP stdio
transport — never write logs to stdout in the server). Every log line carries:
`event` (not `message`), `level`, `sessionId`, and a `correlationId` for command flows.

```ts
log.error('command_failed', { sessionId, correlationId: id, name, durationMs });
```

Never log-interpolate (`` `failed for ${id}` ``) — emit fields. Grep-archaeology doesn't
scale.

## Correlation across the relay

Every agent→browser command gets an `id` (already in `CommandMessageSchema`). Thread it
through bridge routing and the browser's reply so a single command's full path is traceable:
`MCP call → bridge route → browser execute → reply`. Without it, debugging a hung command
across the relay is guesswork.

## Minimum metrics (when we add them)

Per session: command rate, command error rate, P50/P95 command latency, event throughput,
ring-buffer fill %, connected-session count. Surface these in the dev overlay (M4).

## Fail informative, never silent

If no browser session is connected, tools return a clear "no session — is the app running
with `@iris/browser` enabled?" — never hang, never empty-succeed. A blank result that looks
like success is the worst failure mode for an agent.
