import { describe, it, expect, beforeEach } from 'vitest';
import { runQuery } from './query.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

/**
 * Reticle's own UI is not part of the app under test.
 *
 * `reticle_snapshot` has always excluded it. `reticle_query` did not — so the presenter panel and the
 * annotator answered `by: role` exactly like app controls. Measured on a real merchant dashboard,
 * 7 of the 40 buttons an agent could see were Reticle's own: "Pause", "End", "Minimise the panel",
 * "Send", "Copy run", "Export", "Flag a bug for the agent".
 *
 * "Export" is the one that shows why this is a correctness bug and not a tidiness one: that page has
 * its OWN Export button. An agent resolving Export by name could drive the observer, get a perfectly
 * successful action back, and then reason about an app that never moved.
 */
describe('reticle_query does not return Reticle’s own UI as app controls', () => {
  const mountApp = (): void => {
    document.body.innerHTML = '<button data-testid="export">Export</button>';
  };
  const mountPresenter = (): void => {
    const panel = document.createElement('div');
    panel.setAttribute('data-reticle-overlay', '');
    panel.innerHTML =
      '<button data-reticle-pause>Pause</button>' +
      '<button data-reticle-end>End</button>' +
      '<button>Export</button>';
    document.body.append(panel);
  };

  it('returns only the app’s buttons when the presenter is mounted', () => {
    mountApp();
    mountPresenter();
    const result = runQuery({ by: 'role', value: 'button' });
    expect(result.count).toBe(1);
    expect(result.elements[0]?.name ?? result.elements[0]?.text).toBe('Export');
  });

  it('does not resolve a Reticle control that shares a name with an app control', () => {
    // Without the filter this returned two matches and the agent had no way to tell them apart.
    mountApp();
    mountPresenter();
    expect(runQuery({ by: 'text', value: 'Export' }).count).toBe(1);
  });

  it('finds nothing at all when ONLY Reticle’s UI is on the page', () => {
    mountPresenter();
    const result = runQuery({ by: 'role', value: 'button' });
    expect(result.count).toBe(0);
    // And the zero-match hint must not advertise Reticle's own testids as "what IS here".
    expect(JSON.stringify(result.hint ?? {})).not.toContain('reticle');
  });

  it('still finds the annotator-adjacent app content — the filter is scoped, not a blanket', () => {
    document.body.innerHTML = '<button data-testid="flag">Flag a bug</button>';
    const mark = document.createElement('div');
    mark.setAttribute('data-reticle-mark', '');
    mark.innerHTML = '<button>Flag a bug for the agent</button>';
    document.body.append(mark);
    const result = runQuery({ by: 'testid', value: 'flag' });
    expect(result.count).toBe(1);
  });
});
