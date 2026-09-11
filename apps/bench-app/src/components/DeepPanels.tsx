import { useEffect, useRef } from 'react';
import { useApp } from '../store/store.js';
import { API_BASE } from '../lib/api.js';

/**
 * Deep-DOM fixture surface: one web component with an OPEN shadow root, and one same-origin
 * iframe panel. Both are places a tool has to deliberately pierce to see anything — Reticle's snapshot
 * walks `element.shadowRoot` and a same-origin `contentDocument`, so content inside them is reachable;
 * a plain `querySelectorAll('[data-testid]')` on the top document is not.
 *
 * The note that used to sit here — "`reticle_query` cannot cross a shadow boundary, use
 * `reticle_snapshot`" — is STALE and was wrong for long enough to matter. `findCandidates` runs the
 * query against the light DOM and every open shadow root beneath the scope, so `reticle_query` by
 * testid resolves `shadow-status` and `shadow-refresh` directly (verified live). A closed root stays
 * unreachable by design and is reported as a blind spot rather than silently missed.
 */

/** Element + testid names live here so the injector and the fixture cannot drift apart. */
export const SHADOW_TAG = 'bench-status';
export const SHADOW_LABEL_TESTID = 'shadow-status';
export const SHADOW_BUTTON_TESTID = 'shadow-refresh';
export const IFRAME_TESTID = 'deep-iframe';
const PANEL_PATH = '/panel.html';

/** The healthy label text — the injector's typo variant is checked against this. */
const SHADOW_LABEL_OK = 'All systems nominal';

class BenchStatus extends HTMLElement {
  connectedCallback(): void {
    if (this.shadowRoot !== null) return;
    const root = this.attachShadow({ mode: 'open' });
    const label = document.createElement('span');
    label.setAttribute('data-testid', SHADOW_LABEL_TESTID);
    label.textContent = this.getAttribute('label') ?? SHADOW_LABEL_OK;
    const button = document.createElement('button');
    button.setAttribute('data-testid', SHADOW_BUTTON_TESTID);
    button.type = 'button';
    button.textContent = 'Refresh status';
    // A real consequence: the click makes a request, so a dead handler is observable on the network.
    button.addEventListener('click', () => {
      void fetch(`${API_BASE}/api/health`).catch(() => undefined);
    });
    root.append(label, document.createTextNode(' · '), button);
  }
}

if (typeof customElements !== 'undefined' && customElements.get(SHADOW_TAG) === undefined) {
  customElements.define(SHADOW_TAG, BenchStatus);
}

export function DeepPanels(): React.ReactElement {
  const count = useApp((s) => s.deployments.length);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (null === host) return;
    if (null === host.querySelector(SHADOW_TAG)) {
      host.append(document.createElement(SHADOW_TAG));
    }
  }, []);

  return (
    <div className="card" style={{ display: 'grid', gap: 10 }}>
      <div className="card-title">Deep panels</div>
      <div ref={hostRef} data-testid="shadow-host" />
      <iframe
        data-testid={IFRAME_TESTID}
        title="Deployment summary"
        src={`${PANEL_PATH}?count=${String(count)}`}
        style={{ width: '100%', height: 64, border: '1px solid var(--line)', borderRadius: 8 }}
      />
    </div>
  );
}
