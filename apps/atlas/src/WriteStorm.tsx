import * as React from 'react';
import { useEffect, useState } from 'react';

/**
 * An app that rewrites one localStorage key thousands of times a minute with byte-identical content.
 *
 * This is not invented. It is the exact shape of a field app that made Reticle report a confident,
 * specific, WRONG number: the no-op writes filled the server's ring buffer (`held: 2000, dropped:
 * 70482`), and the verdict taken in that window reported `net.total: 0`, `stateDiffs: []` and
 * `state "cad" never changed` — while a POST that had returned 200 inside that same window carried
 * the entire root cause in its body. The agent read the zero and was one step from reporting
 * "clicking Accept fires no network request", which sends a developer to the click handler instead
 * of to the payload the server rejected.
 *
 * Two fixes came out of that and BOTH were shipped against unit tests only, because nothing in this
 * repo behaved like this. That is the gap this fills, and it is the axis Atlas's README already
 * claims: "where truncation, buffer eviction and rate caps actually bite".
 *
 *  1. a write whose value is unchanged emits nothing, so it costs no buffer slot;
 *  2. a window the buffer DID trim reports a floor rather than a total, so absence of evidence is
 *     never typed as evidence of absence.
 *
 * OFF by default and driven by a control, because a permanent storm would poison every other
 * assertion in this fixture — which is a property of the real app too: it only ran while a
 * particular panel was mounted.
 *
 * The written value is deliberately CONSTANT. A storm of genuinely-changing writes is a different
 * (and legitimate) load, and it would prove the opposite of what this is for.
 */

/** Matches the field app's cadence closely enough to starve an unguarded buffer within seconds. */
const WRITES_PER_TICK = 200;
const TICK_MS = 50;
const KEY = 'atlas-ui';
const VALUE = JSON.stringify({ panel: 'shipments', density: 'compact', sort: 'eta' });

export function WriteStorm(): React.ReactElement {
  const [storming, setStorming] = useState(false);
  const [writes, setWrites] = useState(0);

  useEffect(() => {
    if (!storming) return;
    const timer = setInterval(() => {
      for (let i = 0; i < WRITES_PER_TICK; i += 1) localStorage.setItem(KEY, VALUE);
      setWrites((n) => n + WRITES_PER_TICK);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [storming]);

  return (
    <section aria-label="Storage churn">
      <button data-testid="write-storm" onClick={() => setStorming((on) => !on)}>
        {storming ? 'Stop storage churn' : 'Start storage churn'}
      </button>
      <output data-testid="write-storm-count">{writes}</output>
    </section>
  );
}
