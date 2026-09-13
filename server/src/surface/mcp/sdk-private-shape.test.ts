/**
 * The two SDK internals `mcp.ts` monkey-patches must still be there.
 *
 * `@modelcontextprotocol/sdk` is pinned `^1.30.0`, so a MINOR bump installs itself without asking.
 * Both patches reach past the public API — `validateToolInput` for readable argument errors,
 * `_requestHandlers` for the "known but un-advertised" help — and both bail out with a bare `return`
 * when their shape is missing. A rename upstream therefore turns two shipped features off with no
 * error, no red test and, until now, no log line. The `_requestHandlers` one cost a user a long run
 * of false failures the first time it was ABSENT; a silent regression to that state is the same bug.
 *
 * So this suite fails at the fast gate, on the version bump, in CI — not in someone's session.
 * It asserts the shapes on a real SDK server built the way `createMcpServer` builds one, and is
 * deliberately about the SHAPE only: whether the patches behave correctly is the business of
 * `mcp.test.ts` and `unadvertised-tool-over-transport.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { createMcpServer, CALL_TOOL_METHOD } from './mcp.js';
import { TOOL_SURFACE } from '../tools/tool-surface.js';
import type { ToolDeps } from '../tools/tools.js';

const toolDepsForTest = (): ToolDeps =>
  ({ sessions: { resolve: () => ({ id: 'x' }) } }) as unknown as ToolDeps;

describe('the private MCP SDK shapes both monkey-patches depend on', () => {
  it('still exposes validateToolInput, or friendly argument errors are silently off', () => {
    const server = createMcpServer(toolDepsForTest(), TOOL_SURFACE.DEFAULT);
    const target = server as unknown as { validateToolInput?: unknown };
    expect(
      typeof target.validateToolInput,
      'SDK renamed validateToolInput — mcp.ts installFriendlyArgErrors is now a no-op',
    ).toBe('function');
  });

  it('still exposes _requestHandlers with a tools/call entry, or unadvertised help is silently off', () => {
    const server = createMcpServer(toolDepsForTest(), TOOL_SURFACE.DEFAULT);
    const inner = server.server as unknown as { _requestHandlers?: Map<string, unknown> };
    const handlers = inner._requestHandlers;
    expect(
      handlers instanceof Map,
      'SDK renamed _requestHandlers — mcp.ts unadvertised-tool help is now a no-op',
    ).toBe(true);
    // The dispatcher is installed lazily on the first registerTool, so its absence here means the
    // method name moved, not that registration was skipped.
    expect(
      handlers?.get(CALL_TOOL_METHOD),
      `SDK no longer dispatches '${CALL_TOOL_METHOD}' — unadvertised-tool help is now a no-op`,
    ).toBeTypeOf('function');
  });
});
