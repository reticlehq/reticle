import { useEffect, useRef } from 'react';

/**
 * The parts of a real console that live OUTSIDE the ordinary DOM.
 *
 * Every one of these is somewhere a verifier can silently lose sight of the app, and each fails
 * differently — which is the point of having all four side by side:
 *
 *  - **open shadow root** — reachable through `element.shadowRoot`, so a tool that traverses it sees
 *    the content and one that does not silently reports an empty region.
 *  - **closed shadow root** — `shadowRoot` is null by design. NOTHING can read it. The only honest
 *    behaviour is to say so, and it is undetectable in principle, which is worse than it sounds.
 *  - **same-origin iframe** — readable if the tool bothers to descend.
 *  - **cross-origin iframe** — unreadable by same-origin policy, and the one case Reticle already
 *    claims to declare.
 *
 * A design-system console really does look like this: a legacy widget in a shadow root, a billing
 * page embedded from another origin. Treating them as exotic is how a verifier ends up confidently
 * describing three quarters of a screen.
 */

const OPEN_BADGE = 'atlas-open-badge';
const CLOSED_BADGE = 'atlas-closed-badge';

function defineBadges(): void {
  if (customElements.get(OPEN_BADGE) === undefined) {
    customElements.define(
      OPEN_BADGE,
      class extends HTMLElement {
        connectedCallback(): void {
          const root = this.attachShadow({ mode: 'open' });
          root.innerHTML =
            '<span data-testid="open-shadow-status">SLA breach: 3 shipments</span>' +
            '<button data-testid="open-shadow-ack">Acknowledge</button>';
          // A real handler, so "the click landed" and "the app reacted" are distinguishable. The
          // mutation happens INSIDE the shadow root, where a MutationObserver on documentElement
          // does not reach.
          root.querySelector('button')?.addEventListener('click', () => {
            const status = root.querySelector('[data-testid="open-shadow-status"]');
            if (status !== null) status.textContent = 'SLA breach: acknowledged';
          });
        }
      },
    );
  }
  if (customElements.get(CLOSED_BADGE) === undefined) {
    customElements.define(
      CLOSED_BADGE,
      class extends HTMLElement {
        connectedCallback(): void {
          // `closed` — `this.shadowRoot` is null from the outside, for everyone, forever.
          const root = this.attachShadow({ mode: 'closed' });
          root.innerHTML =
            '<span data-testid="closed-shadow-status">Customs hold: 1 shipment</span>' +
            '<button data-testid="closed-shadow-ack">Resolve</button>';
          root.querySelector('button')?.addEventListener('click', () => {
            const status = root.querySelector('[data-testid="closed-shadow-status"]');
            if (status !== null) status.textContent = 'Customs hold: resolved';
          });
        }
      },
    );
  }
}

export function EmbeddedPanels(): React.ReactElement {
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    defineBadges();
  }, []);

  return (
    <section style={{ padding: 20, borderTop: '1px solid #ddd' }} aria-label="alerts">
      <h2 data-testid="panels-title">Alerts</h2>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        {/* Reachable: a tool that walks open shadow roots sees the text and the button. */}
        <div data-testid="open-shadow-host">
          {}
          <atlas-open-badge />
        </div>
        {/* Unreachable by anyone. The honest answer is "there is content here I cannot read". */}
        <div data-testid="closed-shadow-host">
          <atlas-closed-badge />
        </div>
        {/* Same-origin: readable by descending. */}
        <iframe
          data-testid="same-origin-frame"
          title="carrier SLA"
          src="/frames/sla.html"
          style={{ width: 260, height: 90, border: '1px solid #ccc' }}
        />
        {/* Cross-origin: unreadable by same-origin policy.
            A `data:` URL, not a dead port. Pointing at an unserved port only LOOKS cross-origin —
            the load fails and engines disagree about what is left behind: Chromium reports an
            inaccessible document, WebKit leaves an about:blank the page can read, so the same fixture
            declared a cross-origin frame on one engine and not the other. A data: URL is given an
            opaque origin by spec, needs no server, and behaves identically everywhere. */}
        <iframe
          data-testid="cross-origin-frame"
          title="billing"
          src="data:text/html,<p data-testid=%22billing-line%22>Billing: 4200 due</p>"
          style={{ width: 260, height: 90, border: '1px solid #ccc' }}
        />
      </div>
    </section>
  );
}
