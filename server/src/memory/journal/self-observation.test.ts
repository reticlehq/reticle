import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { JournalRecorder, type JournalSink } from './journal-recorder.js';

const SESSION = 'demo';

function net(type: ReticleEvent['type'], url: string, seq: number): ReticleEvent {
  return { t: seq, seq, type, sessionId: SESSION, data: { id: `r${String(seq)}`, url } };
}

function fakeSink(): JournalSink & { events: ReticleEvent[] } {
  const events: ReticleEvent[] = [];
  return {
    events,
    appendEvents(batch) {
      events.push(...batch);
      return Promise.resolve();
    },
    appendAction() {
      return Promise.resolve();
    },
  };
}

function urlsOf(events: readonly ReticleEvent[]): string[] {
  return events.map((e) => String(e.data['url']));
}

describe('the journal does not record Reticle watching itself load', () => {
  it('drops a fetch of Reticle’s own SDK bundle from node_modules', async () => {
    const sink = fakeSink();
    const rec = new JournalRecorder(sink, { now: () => 0, flushAt: 100 });
    rec.observe(
      net(
        EventType.NET_REQUEST,
        'http://localhost:5173/node_modules/@reticlehq/browser/dist/index.js',
        0,
      ),
    );
    await rec.flush();
    expect(urlsOf(sink.events)).toEqual([]);
  });

  it('drops the Vite dep-optimizer copy of the same bundle', async () => {
    const sink = fakeSink();
    const rec = new JournalRecorder(sink, { now: () => 0, flushAt: 100 });
    rec.observe(
      net(
        EventType.NET_REQUEST,
        'http://localhost:5173/node_modules/.vite/deps/@reticlehq_browser.js?v=1',
        0,
      ),
    );
    await rec.flush();
    expect(urlsOf(sink.events)).toEqual([]);
  });

  it('drops the pending and detail halves too, so nothing is left looking hung', async () => {
    const sink = fakeSink();
    const rec = new JournalRecorder(sink, { now: () => 0, flushAt: 100 });
    const url = 'https://cdn.jsdelivr.net/npm/@reticlehq/browser/dist/index.js';
    rec.observe(net(EventType.NET_PENDING, url, 0));
    rec.observe(net(EventType.NET_DETAIL, url, 1));
    rec.observe(net(EventType.NET_REQUEST, url, 2));
    await rec.flush();
    expect(sink.events).toEqual([]);
  });

  it('keeps the app’s own requests, including ones whose path merely resembles ours', async () => {
    const sink = fakeSink();
    const rec = new JournalRecorder(sink, { now: () => 0, flushAt: 100 });
    const kept = [
      'http://localhost:5173/src/main.tsx',
      'http://localhost:5173/api/reticlehq/orders',
      'http://localhost:5173/vendor/reticle-browser.js',
      'http://localhost:5173/core/dist/index.js',
      'http://localhost:5173/adapters/realm/browser/dist/index.js',
      'http://localhost:5173/api/search?q=%40reticlehq%2Fbrowser',
    ];
    kept.forEach((u, i) => rec.observe(net(EventType.NET_REQUEST, u, i)));
    await rec.flush();
    expect(urlsOf(sink.events)).toEqual(kept);
  });

  it('keeps every non-network event untouched', async () => {
    const sink = fakeSink();
    const rec = new JournalRecorder(sink, { now: () => 0, flushAt: 100 });
    rec.observe({
      t: 0,
      seq: 0,
      type: EventType.DOM_TEXT,
      sessionId: SESSION,
      data: { url: 'http://localhost:5173/node_modules/@reticlehq/browser/dist/index.js' },
    });
    await rec.flush();
    expect(sink.events).toHaveLength(1);
  });
});
