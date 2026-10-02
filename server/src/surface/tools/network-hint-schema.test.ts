import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { consoleEmptyHint, netEmptyHint } from '@reticlehq/engine/window/event-filters.js';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { TOOLS } from './tools.js';
import { ReticleTool } from '@reticlehq/core';

/**
 * The declared output shape has to accept what the handler actually returns.
 *
 * Measured on the detection bench: `reticle_network` died with *"Output validation error: Expected
 * string, received object at hint.present[0]"* — not a wrong answer, a dead tool call. And it died
 * ONLY when the filter matched nothing, which is the exact case the hint was added for: the agent
 * asking "did POST /x fire?" about something that did not, the one moment it most needs to be told
 * what DID happen.
 *
 * A schema is not checked against its producer by the type system — the handler returns a record and
 * the schema is data — so nothing here would have gone red. The protocol layer validates at the
 * boundary, which means the first thing that notices is an agent losing a tool call.
 */

function netEvent(url: string): ReticleEvent {
  return {
    t: 1,
    seq: 1,
    type: EventType.NET_REQUEST,
    sessionId: 'demo',
    data: { method: 'GET', url, status: 200 },
  };
}

function outputShape(name: string): z.ZodObject<z.ZodRawShape> {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool?.outputSchema === undefined) throw new Error(`${name} declares no output schema`);
  return z.object(tool.outputSchema);
}

describe('the network zero-match hint the agent gets when its filter missed', () => {
  it('is accepted by the shape the tool advertises', () => {
    const hint = netEmptyHint([netEvent('/api/health')]);
    // Vacuity: an empty hint would satisfy almost any schema.
    expect(hint.present.length).toBeGreaterThan(0);
    expect(() => outputShape(ReticleTool.NETWORK).parse({ calls: [], hint })).not.toThrow();
  });
});

describe('the console zero-match hint, checked for the same class of defect', () => {
  it('is accepted by the shape the tool advertises', () => {
    const hint = consoleEmptyHint([
      {
        t: 1,
        seq: 1,
        type: EventType.CONSOLE_WARN,
        sessionId: 'demo',
        data: { level: 'warn', text: 'hm' },
      },
    ]);
    expect(hint.totalInWindow).toBe(1);
    expect(() => outputShape(ReticleTool.CONSOLE).parse({ logs: [], hint })).not.toThrow();
  });
});
