import { describe, it, expect } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { OBSERVE_TOOLS } from './observe-tools.js';
import { ReticleTool } from './tool-names.js';
import type { ToolDeps } from './tools.js';
import type { Session, SessionManager } from '../session/session.js';

/**
 * #401: `reticle_network` returned full request/response bodies with no way to ask for the list
 * without them, so the cheapest read (method/url/status) paid for the most expensive field. A
 * `bodies: false` switch returns a body-free listing. Adopted from Argus's compact network read.
 */
function ev(type: EventType, data: Record<string, unknown>, t = 1): ReticleEvent {
  return { t, type, sessionId: 's', data };
}

function netDeps(events: ReticleEvent[]): ToolDeps {
  const session = {
    queryEvents: () => Promise.resolve(events),
    bufferHealth: () => ({ total: events.length, dropped: 0 }),
  } as unknown as Session;
  const sessions = { resolve: () => session } as unknown as SessionManager;
  return { sessions } as unknown as ToolDeps;
}

function networkTool() {
  const t = OBSERVE_TOOLS.find((x) => x.name === ReticleTool.NETWORK);
  if (t === undefined) throw new Error('no reticle_network tool');
  return t;
}

const POST = ev(EventType.NET_REQUEST, {
  method: 'POST',
  url: '/api/todos',
  status: 201,
  durationMs: 8,
  requestBody: '{"title":"buy milk"}',
  responseBody: '{"id":7}',
});

type NetResult = { calls: Array<Record<string, unknown>>; bodiesNotCaptured?: string };

describe('reticle_network bodies switch (#401)', () => {
  it('includes bodies by default (unchanged behaviour)', async () => {
    const res = (await networkTool().handler(netDeps([POST]), {})) as NetResult;
    expect(res.calls[0]?.requestBody).toBe('{"title":"buy milk"}');
    expect(res.calls[0]?.responseBody).toBe('{"id":7}');
  });

  it('drops bodies with bodies:false, keeping method/url/status/timing', async () => {
    const res = (await networkTool().handler(netDeps([POST]), { bodies: false })) as NetResult;
    expect(res.calls[0]).toEqual({ method: 'POST', url: '/api/todos', status: 201, ms: 8 });
  });

  it('does NOT raise the "bodies not captured" note when the caller asked for bodies:false', async () => {
    // That note means "capture is OFF, this body is unseen". A caller who deliberately omitted
    // bodies did not lose them to a missing config — without gating, stripping every body would
    // make the note fire on every body-free read, advising a fix for a problem that isn't there.
    const res = (await networkTool().handler(netDeps([POST]), { bodies: false })) as NetResult;
    expect(res.bodiesNotCaptured).toBeUndefined();
  });
});
