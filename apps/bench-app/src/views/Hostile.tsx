import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../lib/api.js';

/**
 * The hostile fixture: a page that NEVER goes quiet on its own. Two independent churn sources —
 * a fake real-time feed appending rows continuously, and a count-up ticker mutating text every frame —
 * plus a large list and a control that fires ONE failing request.
 *
 * It exists to make two acceptances testable, both of which a calm fixture cannot exercise:
 * - ambient learning: `settled` must still fire here (the churn region is learned as ambient),
 * so act_and_wait does not time out on a healthy real-time page.
 * - B12c priority eviction: the single failed request must survive the flood instead of being
 * pushed out of the ring buffer by thousands of low-signal churn events.
 */

const FEED_INTERVAL_MS = 100; // ~10 messages/sec — the real-time-chat floor
const TICKER_INTERVAL_MS = 16; // ~60fps text mutation — the count-up-animation floor
const ROW_COUNT = 5000;

export function Hostile(): React.ReactElement {
  const [messages, setMessages] = useState<string[]>([]);
  const [tick, setTick] = useState(0);
  const [lastFault, setLastFault] = useState<string>('none');
  const seq = useRef(0);

  // Churn source 1: a fake WS feed appending a row ~10x/sec, forever.
  useEffect(() => {
    const id = setInterval(() => {
      seq.current += 1;
      setMessages((prev) => [...prev.slice(-40), `msg ${String(seq.current)}`]);
    }, FEED_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // Churn source 2: a count-up ticker mutating text every frame (the dom.text flood).
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), TICKER_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const fireFailingRequest = (): void => {
    // The ONE scarce piece of evidence that must survive the churn.
    void fetch(`${API_BASE}/api/broken/500`)
      .then((r) => setLastFault(`status ${String(r.status)}`))
      .catch((e: unknown) => setLastFault(e instanceof Error ? e.message : 'failed'));
  };

  return (
    <section data-testid="hostile-view">
      <h2>Hostile page</h2>
      <p>
        Ticker: <span data-testid="hostile-ticker">{tick}</span> · feed rows:{' '}
        <span data-testid="hostile-feed-count">{messages.length}</span>
      </p>

      <button type="button" data-testid="hostile-fail-request" onClick={fireFailingRequest}>
        Fire failing request
      </button>
      <span data-testid="hostile-last-fault">{lastFault}</span>

      {/* Churning feed region — the ambient area the settle oracle must learn and exclude. */}
      <ul data-testid="hostile-feed" style={{ maxHeight: 160, overflow: 'auto', margin: 0 }}>
        {messages.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>

      {/* A large list: only a window is mounted, so unmounted rows are a real blind spot. */}
      <div data-testid="hostile-grid" style={{ maxHeight: 240, overflow: 'auto' }}>
        {Array.from({ length: 60 }, (_, i) => (
          <div key={i} data-testid={`hostile-row-${String(i)}`}>
            row {i} of {ROW_COUNT}
          </div>
        ))}
      </div>
    </section>
  );
}
