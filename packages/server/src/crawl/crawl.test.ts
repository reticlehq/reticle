import { describe, expect, it } from 'vitest';
import {
  CrawlAnomalyKind,
  EventType,
  IrisCommand,
  type CommandResult,
  type IrisEvent,
} from '@syrin/iris-protocol';
import { crawl, type CrawlSession } from './crawl.js';

const noSleep = (): Promise<void> => Promise.resolve();

interface RefScript {
  events?: { type: EventType; data?: Record<string, unknown> }[];
  dispatched?: boolean;
}

/** A scripted CrawlSession: SNAPSHOT returns `tree`; each ACT pushes that ref's scripted events. */
function fakeSession(tree: string, perRef: Record<string, RefScript>): CrawlSession {
  let clock = 0;
  const buffer: IrisEvent[] = [];
  const ok = (result: unknown): Promise<CommandResult> =>
    Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
  return {
    elapsed: () => clock,
    eventsSince: (since) => buffer.filter((e) => e.t > since),
    command: (name, args = {}) => {
      if (name === IrisCommand.SNAPSHOT) return ok({ tree });
      if (name === IrisCommand.ACT) {
        const ref = typeof args['ref'] === 'string' ? args['ref'] : '';
        clock += 1;
        for (const e of perRef[ref]?.events ?? []) {
          buffer.push({ t: clock, type: e.type, sessionId: 's', data: e.data ?? {} });
        }
        return ok({ dispatched: perRef[ref]?.dispatched ?? true });
      }
      return ok({});
    },
  };
}

const tree = (lines: string[]): string => lines.join('\n');
const domActivity = { events: [{ type: EventType.DOM_ADDED }] };

describe('crawl — autonomous smart-monkey', () => {
  it('1: a healthy app yields zero anomalies and visits every control', async () => {
    const session = fakeSession(tree(['button "Save" (ref=e1)', 'link "Home" (ref=e2)']), {
      e1: domActivity,
      e2: { events: [{ type: EventType.ROUTE_CHANGE }] },
    });
    const r = await crawl(session, {}, noSleep);
    expect(r.interactiveFound).toBe(2);
    expect(r.stepsRun).toBe(2);
    expect(r.anomalies).toEqual([]);
    expect(r.truncated).toBe(false);
    expect(r.visited).toEqual(['button "Save"', 'link "Home"']);
  });

  it('2: a console error during a click is reported with its control', async () => {
    const session = fakeSession(tree(['button "Boom" (ref=e1)']), {
      e1: { events: [{ type: EventType.CONSOLE_ERROR, data: { message: 'kaboom' } }] },
    });
    const r = await crawl(session, {}, noSleep);
    expect(r.counts.consoleErrors).toBe(1);
    expect(r.anomalies[0]).toMatchObject({
      kind: CrawlAnomalyKind.CONSOLE_ERROR,
      ref: 'e1',
      desc: 'button "Boom"',
      detail: 'kaboom',
    });
  });

  it('3: a failed request (status ≥ 400) is reported', async () => {
    const session = fakeSession(tree(['button "Order" (ref=e1)']), {
      e1: {
        events: [
          { type: EventType.NET_REQUEST, data: { method: 'POST', url: '/api/order', status: 500 } },
        ],
      },
    });
    const r = await crawl(session, {}, noSleep);
    expect(r.counts.failedRequests).toBe(1);
    expect(r.anomalies[0]?.kind).toBe(CrawlAnomalyKind.FAILED_REQUEST);
    expect(r.anomalies[0]?.detail).toContain('/api/order');
  });

  it('4: a dispatched click with no reaction is a DEAD control', async () => {
    const session = fakeSession(tree(['button "Nothing" (ref=e1)']), { e1: { events: [] } });
    const r = await crawl(session, {}, noSleep);
    expect(r.counts.deadControls).toBe(1);
    expect(r.anomalies[0]?.kind).toBe(CrawlAnomalyKind.DEAD_CONTROL);
  });

  it('5: a control that could not dispatch is NOT flagged dead', async () => {
    const session = fakeSession(tree(['button "Stale" (ref=e1)']), {
      e1: { events: [], dispatched: false },
    });
    const r = await crawl(session, {}, noSleep);
    expect(r.counts.deadControls).toBe(0);
    expect(r.anomalies).toEqual([]);
  });

  it('6: a 200 request alone is activity, not an anomaly', async () => {
    const session = fakeSession(tree(['button "OK" (ref=e1)']), {
      e1: { events: [{ type: EventType.NET_REQUEST, data: { url: '/api/ok', status: 200 } }] },
    });
    const r = await crawl(session, {}, noSleep);
    expect(r.anomalies).toEqual([]);
    expect(r.counts.deadControls).toBe(0);
  });

  it('7: maxSteps bounds coverage and flags truncated', async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `button "B${i}" (ref=e${i})`);
    const session = fakeSession(tree(lines), {});
    const r = await crawl(session, { maxSteps: 2 }, noSleep);
    expect(r.stepsRun).toBe(2);
    expect(r.visited).toHaveLength(2);
    expect(r.truncated).toBe(true);
    expect(r.interactiveFound).toBe(5);
  });

  it('8: identical controls are clicked once (dedup by description)', async () => {
    const session = fakeSession(tree(['button "Dup" (ref=e1)', 'button "Dup" (ref=e2)']), {
      e1: domActivity,
      e2: domActivity,
    });
    const r = await crawl(session, {}, noSleep);
    expect(r.stepsRun).toBe(1);
    expect(r.visited).toEqual(['button "Dup"']);
  });
});
