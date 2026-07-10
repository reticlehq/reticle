import { describe, it, expect, beforeEach } from 'vitest';
import { QueryBy } from '@reticlehq/core';
import { matchQuery } from './query.js';
import { registerAdapter, type ComponentInfo } from '../registry/adapters.js';

/**
 * Auto-anchor resolution: address an element by its source location or component identity, with NO
 * hand-added data-testid. Source (the babel-stamped data-reticle-source) is the precise path; component
 * name is the coarse fallback via the framework adapter.
 */
function render(html: string): void {
  document.body.innerHTML = html;
}

describe('matchQuery by component / source (auto-anchors)', () => {
  beforeEach(() => render(''));

  it('resolves the exact element by source location (line-level, column-agnostic)', () => {
    render(
      '<button data-reticle-source="src/views/Deployments.tsx:104:10">New deploy</button>' +
        '<button data-reticle-source="src/views/Deployments.tsx:200:4">Cancel</button>',
    );
    const r = matchQuery({
      by: QueryBy.COMPONENT,
      source: { file: 'src/views/Deployments.tsx', line: 104 },
    });
    expect(r.matched).toBe(true);
    expect(r.count).toBe(1);
    expect(r.elements[0]?.name).toBe('New deploy');
  });

  it('does not match a different source line', () => {
    render('<button data-reticle-source="src/views/Deployments.tsx:104:10">New deploy</button>');
    const r = matchQuery({
      by: QueryBy.COMPONENT,
      source: { file: 'src/views/Deployments.tsx', line: 999 },
    });
    expect(r.matched).toBe(false);
  });

  it('falls back to component name via the registered adapter when no source is given', () => {
    // A fake adapter that reads the nearest component from a data-component attribute.
    registerAdapter({
      name: 'test-fake',
      identify: (el: Element): ComponentInfo | null => {
        const owner = el.closest('[data-component]')?.getAttribute('data-component');
        return owner === null || owner === undefined ? null : { componentStack: [owner] };
      },
    });
    render(
      '<div data-component="Deployments"><button>New deploy</button></div>' +
        '<div data-component="Sidebar"><button>Home</button></div>',
    );
    const r = matchQuery({ by: QueryBy.COMPONENT, component: 'Deployments' });
    expect(r.matched).toBe(true);
    // The Deployments subtree button (and its wrapper) resolve; the Sidebar button does not.
    expect(r.elements.some((e) => e.name === 'New deploy')).toBe(true);
    expect(r.elements.some((e) => e.name === 'Home')).toBe(false);
  });

  it('source takes precedence over component name when both are present', () => {
    registerAdapter({ name: 'test-fake', identify: (): ComponentInfo | null => null });
    render('<button data-reticle-source="src/A.tsx:5:0">Precise</button>');
    const r = matchQuery({
      by: QueryBy.COMPONENT,
      source: { file: 'src/A.tsx', line: 5 },
      component: 'Nonexistent',
    });
    expect(r.matched).toBe(true);
    expect(r.elements[0]?.name).toBe('Precise');
  });
});
