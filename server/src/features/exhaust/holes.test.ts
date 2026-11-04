import { describe, expect, it } from 'vitest';
import { HoleKind, emptyLedger, holesOf, mergeLedger } from './ledger.js';

const ledger = mergeLedger(emptyLedger(), {
  routes: { discovered: ['/', '/settings', '/admin'], reached: ['/'] },
  controls: {
    seen: ['button "Save"', 'link "Admin"', 'textbox "Name"'],
    touched: ['button "Save"'],
  },
  writes: { seen: ['POST /api/items', 'DELETE /api/items/#'], branched: ['POST /api/items'] },
  edges: { probed: ['textbox "Name"'] },
  code: {
    'src/App.tsx': {
      'save@10': { name: 'save', executed: true },
      'purge@90': { name: 'purge', executed: false },
    },
  },
});

describe('holesOf', () => {
  it('names every route, control, write and function never reached', () => {
    const holes = holesOf(ledger);
    expect(holes[HoleKind.ROUTES].items).toEqual(['/settings', '/admin']);
    expect(holes[HoleKind.CONTROLS].items).toEqual(['link "Admin"']);
    expect(holes[HoleKind.WRITES].items).toEqual(['DELETE /api/items/#']);
    expect(holes[HoleKind.FUNCTIONS].items).toEqual(['src/App.tsx: purge']);
    expect(holes[HoleKind.EDGES].items).toEqual(['button "Save"', 'link "Admin"']);
  });

  it('says a level was not measured instead of reporting it empty', () => {
    const holes = holesOf(emptyLedger());
    expect(holes[HoleKind.FUNCTIONS].measured).toBe(false);
    expect(holes[HoleKind.FUNCTIONS].note).toBeDefined();
    expect(holes[HoleKind.COMPONENTS].measured).toBe(false);
    expect(holes[HoleKind.COMPONENTS].note).toBeDefined();
    expect(holes[HoleKind.EDGES].measured).toBe(false);
  });

  it('names components never rendered when an inventory is given', () => {
    const holes = holesOf(ledger, { known: ['App', 'AdminPanel', 'Toast'], rendered: ['App'] });
    expect(holes[HoleKind.COMPONENTS]).toEqual({ measured: true, items: ['AdminPanel', 'Toast'] });
  });

  it('counts the items it does not name, so a long list is never cut in silence', () => {
    const seen = Array.from(
      { length: 60 },
      (_, i) => `button "B${String.fromCharCode(65 + (i % 26))}${String(i)}"`,
    );
    const holes = holesOf(mergeLedger(emptyLedger(), { controls: { seen } }));
    const list = holes[HoleKind.CONTROLS];
    expect(list.items.length + (list.overflow ?? 0)).toBe(new Set(seen).size);
    expect(list.overflow).toBeGreaterThan(0);
  });
});
