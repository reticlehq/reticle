/**
 * Structured logging to stderr. stdout is reserved for the MCP stdio transport — never
 * write logs there. See skills/observability.md.
 */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ event, ...fields });
  process.stderr.write(`${line}\n`);
}
