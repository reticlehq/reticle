// Honesty / false-green benchmark scenarios. Each is a GREEN verdict (the action passed) over a real
// observation window — the question is NOT "did it pass" but "is the pass presented as honestly as
// reality warrants". `reality` is the ground truth an honest verdict MUST disclose. the pre-honesty baseline has no honesty
// block, so it discloses nothing; the honesty layer composes one. The metric is false-green rate: a green that hides
// a real caveat is a false green (the operator trusts more than the tool actually proved).

import { EventType, BlindSpotKind } from '@reticlehq/core';

let seq = 0;
const ev = (type, data) => ({ t: ++seq, seq, type, sessionId: 'bench', data });

export const HONESTY_SCENARIOS = [
  {
    name: 'cross-origin-iframe-present',
    desc: 'Green act, but a cross-origin iframe on the page was unobservable',
    grade: 'signal',
    events: [
      ev(EventType.SIGNAL, { name: 'order:placed' }),
      ev(EventType.BLIND_SPOT, { kind: BlindSpotKind.CROSS_ORIGIN_IFRAME, count: 1 }),
    ],
    reality: { coverageGap: true, truncated: false, weakGrade: false },
  },
  {
    name: 'capture-truncated',
    desc: 'Green act, but a DOM-mutation flood truncated the capture (evidence dropped)',
    grade: 'net',
    events: [
      ev(EventType.NET_REQUEST, { method: 'POST', url: '/api/save', status: 200, ok: true }),
      ev(EventType.TRUNCATED, { channel: 'dom', dropped: 214 }),
    ],
    reality: { coverageGap: false, truncated: true, weakGrade: false },
  },
  {
    name: 'presence-only-green',
    desc: 'Green act that only proved an element EXISTS — no signal/net/state consequence asserted',
    grade: 'presence',
    events: [ev(EventType.DOM_ADDED, { role: 'button' })],
    reality: { coverageGap: false, truncated: false, weakGrade: true },
  },
  {
    name: 'blindspot-and-truncation',
    desc: 'Green act with BOTH an unobserved cross-origin frame and a truncated capture',
    grade: 'presence',
    events: [
      ev(EventType.BLIND_SPOT, { kind: BlindSpotKind.CROSS_ORIGIN_IFRAME, count: 2 }),
      ev(EventType.TRUNCATED, { channel: 'dom', dropped: 90 }),
    ],
    reality: { coverageGap: true, truncated: true, weakGrade: true },
  },
  {
    // CONTROL: a genuinely trustworthy green. A good honesty benchmark must NOT over-flag these —
    // if the honesty layer marked this partial/dirty it would cry wolf and be as useless as silence.
    name: 'clean-signal-green (control)',
    desc: 'Green act, strong signal grade, full coverage, no truncation — nothing to disclose',
    grade: 'signal',
    events: [
      ev(EventType.SIGNAL, { name: 'nav:changed' }),
      ev(EventType.ROUTE_CHANGE, { pathname: '/next' }),
    ],
    reality: { coverageGap: false, truncated: false, weakGrade: false },
  },
];
