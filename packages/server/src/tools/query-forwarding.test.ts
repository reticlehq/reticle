/**
 * A query input that is declared but not FORWARDED is worse than one that does not exist.
 *
 * `reticle_query`'s handler forwards an explicit allowlist to the browser, so an input added to the
 * schema is silently dropped unless it is also added there. The tool then accepts the argument,
 * returns a well-formed result computed without it, and nothing anywhere says so.
 *
 * It has now happened twice. `attrs` was declared and dropped, and the unit tests missed it because
 * they called the DOM query directly, below the layer that was broken. `self` — the fix for an
 * agent that could not get a ref for a plain layout container — was declared, implemented in the
 * browser, unit-tested the same way, and dropped in the same place, so the first live call returned
 * zero matches on an element that was plainly there.
 *
 * The existing comment warning about this is not a guard. This is.
 */

import { describe, expect, it } from 'vitest';
import { ReticleTool } from './tool-names.js';
import { TOOLS } from './tools.js';
import type { ToolDeps } from './tool-kit.js';

const queryTool = TOOLS.find((tool) => ReticleTool.QUERY === tool.name);

/** Capture the payload the handler sends to the browser, instead of sending it. */
function capturingDeps(sink: (payload: Record<string, unknown>) => void): ToolDeps {
  return {
    sessions: {
      resolve: () => ({
        command: (_name: string, payload: Record<string, unknown>) => {
          sink(payload);
          return Promise.resolve({ ok: true, result: { elements: [], count: 0 } });
        },
      }),
    },
  } as unknown as ToolDeps;
}

async function payloadFor(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  let sent: Record<string, unknown> = {};
  await queryTool?.handler(
    capturingDeps((payload) => {
      sent = payload;
    }),
    args,
  );
  return sent;
}

describe('reticle_query forwards what it declares', () => {
  it('forwards `self`, the flag that reaches a container with no semantics of its own', async () => {
    const payload = await payloadFor({ scope: '.grid-lists', self: true });
    expect(payload['self']).toBe(true);
    expect(payload['scope']).toBe('.grid-lists');
  });

  it('forwards `attrs`, which was dropped the same way once before', async () => {
    const payload = await payloadFor({ by: 'role', value: 'link', attrs: ['href'] });
    expect(payload['attrs']).toEqual(['href']);
  });

  it('forwards the locator fields', async () => {
    const payload = await payloadFor({ by: 'role', value: 'button', name: 'Save' });
    expect(payload['by']).toBe('role');
    expect(payload['value']).toBe('button');
    expect(payload['name']).toBe('Save');
  });

  it('declares every field it forwards, so the two lists cannot drift apart silently', () => {
    // Both directions matter: a forwarded-but-undeclared field is unreachable over MCP (a strict
    // client rejects it), and a declared-but-unforwarded one is silently ignored.
    const declared = new Set(Object.keys(queryTool?.inputSchema ?? {}));
    for (const forwarded of ['by', 'value', 'name', 'scope', 'attrs', 'self']) {
      expect(declared.has(forwarded), `${forwarded} is forwarded but not declared`).toBe(true);
    }
  });
});
