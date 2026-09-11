import { describe, expect, it, afterEach } from 'vitest';
import { buildSnapshot } from './snapshot.js';
import { installShadowRegistry } from './shadow-registry.js';

/**
 * `query` learned to reach closed shadow roots — captured at the instant `attachShadow` returns one —
 * before the snapshot did, so the two tools disagreed about what is on the page. That asymmetry costs
 * more in the snapshot: it is the tree an agent reads to decide what to address, and nobody queries
 * for content they have no reason to believe exists.
 */
describe('snapshot pierces what query can reach', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
    document.body.innerHTML = '';
  });

  it('pierces a CLOSED shadow root the registry captured', () => {
    stop = installShadowRegistry();
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.attachShadow({ mode: 'closed' }).innerHTML = '<button>Resolve</button>';
    expect(host.shadowRoot).toBeNull(); // still unreadable to everyone else
    expect(buildSnapshot().tree).toContain('Resolve');
  });

  it('leaves a closed root it never captured alone, rather than inventing one', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.attachShadow({ mode: 'closed' }).innerHTML = '<button>Invisible</button>';
    stop = installShadowRegistry(); // installed too late to have caught it
    expect(buildSnapshot().tree).not.toContain('Invisible');
  });

  it('still pierces an OPEN shadow root', () => {
    stop = installShadowRegistry();
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.attachShadow({ mode: 'open' }).innerHTML = '<button>Acknowledge</button>';
    expect(buildSnapshot().tree).toContain('Acknowledge');
  });

  it('pierces a same-origin frame', () => {
    stop = installShadowRegistry();
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    if (null === doc) throw new Error('jsdom gave no frame document');
    doc.body.innerHTML = '<button>Escalate</button>';
    expect(buildSnapshot().tree).toContain('Escalate');
  });
});
