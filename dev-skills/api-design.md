# dev-skills/api-design.md — MCP Tool / API Design

**Open when:** adding or changing an MCP tool. (Foundation II.5 + API section.)

## Iris's "API" is its MCP tool surface

There's no REST API. The public contract is the MCP tools in
`packages/server/src/tool-names.ts`, specified in `plan/05`. Treat it like a public API.

## Rules

1. **Name from the constant.** Add to `IrisTool` first; never inline a tool name.
2. **Validate args with zod** (`inputSchema`). Reject malformed input with a clear error,
   never coerce silently.
3. **Stable, evidence-shaped output.** Tools return structured objects (snapshot, reaction
   report, diff, verdict). Document the shape; don't change it casually — agents depend on it.
4. **`since` cursors everywhere** so act→observe sequences are race-free.
5. **Read vs write separation.** Read-only tools have no side effects and skip confirm
   gates; write tools (`act`) honor the security blocklist.

## Idempotency

`act` is **not** idempotent (clicking twice clicks twice — correct). But control tools that
create named artifacts (`baseline_save`, `record_start`) must be idempotent on the name:
saving the same name twice overwrites deterministically; starting a recording that's already
running returns the existing one, not a duplicate. Anything that could be retried by the
agent after a timeout must be safe to retry.

## Versioning

The wire protocol carries `IRIS_PROTOCOL_VERSION`. Bump it on a breaking message change and
have the bridge reject mismatched SDKs with a clear upgrade message — never fail obscurely.
