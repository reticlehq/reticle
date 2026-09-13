/**
 * What the advertised tool surface COSTS a client, measured off a real `tools/list` response.
 *
 * Every MCP client (Claude Code, Cursor) re-sends the tool block to the model on EVERY turn, so this
 * payload is multiplied by turn count before one byte of evidence is counted. `surface-sizes.test.ts`
 * pins the COUNT — the budget editors enforce across all connected servers — and is blind to size:
 * one sentence added to a parameter description leaves every count identical and is paid on every
 * turn of every session for every user. That is the number this file pins.
 *
 * Two properties, and the second is the one with teeth:
 *
 *   SIZE      the serialized default surface stays under a documented budget (a ratchet set at the
 *             measured value, not an aspiration).
 *   STABILITY the serialized surface is BYTE-IDENTICAL across `tools/list` calls in one session,
 *             whatever the daemon's session state. A client caches the tool list; anything
 *             interpolated into a name, description or input schema — a version-skew nudge, a
 *             session id, a per-session recommendation — invalidates that cache every turn and makes
 *             every user pay the whole block again. Guidance in a description is paid every turn;
 *             guidance in a tool RESULT is paid once.
 */

import { describe, expect, it } from 'vitest';
import { createMcpServer } from '../mcp/mcp.js';
import { TOOL_SURFACE, type ToolSurface } from './tool-surface.js';
import type { ToolDeps } from './tools.js';

/** A session state the daemon can be in. Each one builds its own server, as a fresh client would. */
type SessionState = 'no-session' | 'one-session' | 'skewed-session';

const depsFor = (state: SessionState): ToolDeps => {
  const session = {
    id: 'sess-1',
    url: 'http://localhost:5173/',
    ...('skewed-session' === state
      ? { versionSkew: 'browser SDK 2.0.0 is older than the server 2.14.0' }
      : {}),
  };
  return {
    sessions: {
      resolve: () => {
        if ('no-session' === state) throw new Error('no session is connected');
        return session;
      },
      get: () => ('no-session' === state ? undefined : session),
      list: () => ('no-session' === state ? [] : [session]),
    },
    now: () => 1_000,
  } as unknown as ToolDeps;
};

/** The `tools/list` payload exactly as a client receives it, over a real transport. */
const listToolsJson = async (
  surface: ToolSurface,
  state: SessionState,
  previouslyConnected: boolean,
): Promise<string> => {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const server = createMcpServer(depsFor(state), surface, previouslyConnected);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'c', version: '0' });
  await client.connect(clientTransport);
  try {
    return JSON.stringify((await client.listTools()).tools);
  } finally {
    await client.close();
    await server.close();
  }
};

const bytesOf = (json: string): number => Buffer.byteLength(json, 'utf8');

/**
 * The ratchet, in bytes of the serialized DEFAULT `tools/list` payload.
 *
 * MEASURED 2026-09-09 on this checkout, off the real wire (`node dist/cli.js mcp`, one `tools/list`,
 * `JSON.stringify(result.tools)`): **18 tools, 22,680 bytes** — ~21,978 bytes once a client re-shapes
 * them into an Anthropic `tools` block, so roughly 5,500 tokens. That block is re-sent on EVERY turn:
 * at the ~19 turns the Layer B benchmark takes per scenario it is ~104k tokens of schema before one
 * byte of evidence is counted, against scenario totals in the low hundreds of thousands. It is the
 * single largest line item this product controls, and `surface-sizes.test.ts` — which pins the tool
 * COUNT, the budget editors enforce across all connected servers — cannot see it move: a sentence
 * added to a parameter description leaves every count identical.
 *
 * Where it sits, measured previously and unchanged in shape: `inputSchema` is ~76% of the payload and
 * parameter descriptions are about half of that, so the next real saving is in parameter prose, not
 * in dropping tools. Do not trim by eye — a description that stops a malformed call is worth more
 * than the bytes it costs (one bad call is a whole extra turn), and CLAUDE.md's rule stands: a token
 * optimisation ships with a correctness measurement beside it.
 *
 * The budget is today's value plus ~1.4%: room to fix a typo, none to add a paragraph. Going over is
 * not forbidden, it is a DECISION — move the number and write the reason here. Coming in well under,
 * move it down.
 */
const DEFAULT_SURFACE_BYTE_BUDGET = 24_000;
// Raised once, deliberately, from 23_000 — with the measurement that bought it.
//
// `reticle_verify` was promoted into the default surface and costs 898 B on the wire (22,680 ->
// 23,578, ~225 tokens/turn). What it buys, measured on the Layer B agent loop: on a CLEAN app the
// agent previously burned all 25 turns and never concluded, at 333k tokens, because every other
// advertised tool answers "here is more to look at" and none can say "there is nothing more".
// `verify` is the only advertised exit. 225 tokens a turn against a loop that did not end is not a
// close trade.
//
// The ratchet stays a ratchet: this is the only raise, it names its evidence, and the next one has
// to do the same.

describe('advertised surface cost', () => {
  it(`the default surface fits in ${String(DEFAULT_SURFACE_BYTE_BUDGET)} bytes of tools/list`, async () => {
    const bytes = bytesOf(await listToolsJson(TOOL_SURFACE.DEFAULT, 'no-session', false));
    // A budget assertion alone passes on an EMPTY payload, which is how a broken transport reads as
    // a spectacular saving. Both this and the stability checks below serialize the same call, so one
    // floor covers them all.
    expect(
      bytes,
      'the surface serialized to nothing — this measures a broken transport',
    ).toBeGreaterThan(10_000);
    expect(
      bytes,
      `default tools/list is ${String(bytes)} B (~${String(Math.round(bytes / 4))} tokens), budget ${String(DEFAULT_SURFACE_BYTE_BUDGET)} B. ` +
        'This block is re-sent on EVERY turn of EVERY session, so a byte here is multiplied by turn count. ' +
        'Trim parameter prose (the largest slice) or raise the budget deliberately, with the reason written here.',
    ).toBeLessThanOrEqual(DEFAULT_SURFACE_BYTE_BUDGET);
  });
});

describe('advertised surface is byte-stable across tools/list calls', () => {
  it('is identical on two consecutive lists from one session', async () => {
    const first = await listToolsJson(TOOL_SURFACE.DEFAULT, 'one-session', true);
    const second = await listToolsJson(TOOL_SURFACE.DEFAULT, 'one-session', true);
    expect(second).toBe(first);
  });

  it.each([TOOL_SURFACE.DEFAULT, TOOL_SURFACE.ALL, TOOL_SURFACE.LEAN, TOOL_SURFACE.VERIFY])(
    '%s does not vary with session state',
    async (surface) => {
      const states: SessionState[] = ['no-session', 'one-session', 'skewed-session'];
      const [baseline, ...rest] = await Promise.all(
        states.map(async (state) => listToolsJson(surface, state, false)),
      );
      for (const [index, payload] of rest.entries()) {
        expect(payload, `${surface} differs under ${String(states[index + 1])}`).toBe(baseline);
      }
    },
  );

  it('does not vary with whether an app has ever connected', async () => {
    // `previouslyConnected` changes the server INSTRUCTIONS, which are handshake-scoped and paid
    // once. If it ever reached a tool description it would invalidate the client's cache instead.
    const cold = await listToolsJson(TOOL_SURFACE.DEFAULT, 'no-session', false);
    const warm = await listToolsJson(TOOL_SURFACE.DEFAULT, 'one-session', true);
    expect(warm).toBe(cold);
  });
});
