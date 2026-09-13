import { describe, expect, it } from 'vitest';
import { reconcile, entitiesIn } from './reconcile.js';

describe('entity extraction', () => {
  it('finds records inside the usual envelopes', () => {
    expect(entitiesIn({ items: [{ id: 'a' }, { id: 'b' }] })).toHaveLength(2);
    expect(entitiesIn({ data: { results: [{ id: 'c' }] } })).toHaveLength(1);
    expect(entitiesIn([{ id: 'd' }])).toHaveLength(1);
  });

  it('ignores objects with no identity — they cannot be tied to anything on screen', () => {
    expect(entitiesIn({ items: [{ amount: 100 }] })).toHaveLength(0);
  });
});

describe('currency rendered as the wrong one', () => {
  it('reports a USD amount shown with a rupee sign', () => {
    const found = reconcile(
      [{ items: [{ id: 'pay_1', amount: 7997, currency: 'USD' }] }],
      'text "₹79.97"',
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.field).toBe('currency');
    expect(found[0]?.rendered).toBe('₹');
    expect(found[0]?.why).toContain('USD 7997');
  });

  it('stays silent when the right marker is used', () => {
    expect(
      reconcile([{ items: [{ id: 'pay_1', amount: 7997, currency: 'USD' }] }], 'text "$79.97"'),
    ).toEqual([]);
  });

  it('accepts an alternative marker for the same currency', () => {
    expect(
      reconcile([{ items: [{ id: 'p', amount: 118701, currency: 'INR' }] }], 'Rs. 1187.01'),
    ).toEqual([]);
  });

  it('stays silent when the amount is not on screen at all', () => {
    // Off-page rows are a coverage question, not a rendering one — and virtualized lists make this
    // the common case, so treating "absent" as "wrong" would fire on every long table.
    expect(
      reconcile([{ items: [{ id: 'pay_1', amount: 7997, currency: 'USD' }] }], 'nothing here'),
    ).toEqual([]);
  });

  it('handles a zero-decimal currency, where the minor unit IS the major unit', () => {
    expect(reconcile([{ items: [{ id: 'p', amount: 500, currency: 'JPY' }] }], '¥500')).toEqual([]);
    expect(
      reconcile([{ items: [{ id: 'p', amount: 500, currency: 'JPY' }] }], '₹500'),
    ).toHaveLength(1);
  });

  it('reports each entity once', () => {
    const body = { items: [{ id: 'pay_1', amount: 7997, currency: 'USD' }] };
    expect(reconcile([body, body], '₹79.97')).toHaveLength(1);
  });
});

describe('a state the page never shows', () => {
  const settlements = {
    items: [
      { id: 's1', status: 'processed' },
      { id: 's2', status: 'on_hold' },
    ],
  };

  it('reports a record displayed as something it is not', () => {
    const found = reconcile([settlements], 'badge "processed" badge "pending"');
    expect(found).toHaveLength(1);
    expect(found[0]?.entity).toBe('s2');
    expect(found[0]?.api).toBe('on_hold');
  });

  it('accepts a humanised rendering of the same value', () => {
    expect(reconcile([settlements], 'badge "processed" badge "On Hold"')).toEqual([]);
  });

  it('stays silent when the UI shows no status at all — that is a design choice', () => {
    expect(reconcile([settlements], 'a page with no statuses on it')).toEqual([]);
  });

  it('stays silent when every status is rendered', () => {
    expect(reconcile([settlements], 'processed on_hold')).toEqual([]);
  });
});

describe('money as real interfaces actually print it', () => {
  // Matching only the ungrouped form finds nothing on any app that formats its money — which is all
  // of them. Measured on a console whose cells read "₹44,573.44" while the check sought "44573.44".
  const usd = [{ items: [{ id: 'p', declaredValueMinor: 4457344, currency: 'USD' }] }];

  it('finds a western-grouped amount', () => {
    expect(reconcile(usd, 'value "₹44,573.44"')).toHaveLength(1);
  });

  it('finds an ungrouped amount', () => {
    expect(reconcile(usd, 'value "₹44573.44"')).toHaveLength(1);
  });

  it('finds a European-formatted amount', () => {
    expect(reconcile(usd, 'value "₹44.573,44"')).toHaveLength(1);
  });

  it('finds an Indian-grouped amount', () => {
    expect(
      reconcile(
        [{ items: [{ id: 'p', total: 12246406, currency: 'USD' }] }],
        'value "₹1,22,464.06"',
      ),
    ).toHaveLength(1);
  });

  it('reads money from ANY numeric field of an entity that declares a currency', () => {
    // The three real APIs measured here name it `amount`, `declaredValueMinor` and `total`.
    for (const field of ['amount', 'declaredValueMinor', 'total', 'grandTotalMinor']) {
      expect(
        reconcile([{ items: [{ id: 'p', [field]: 7997, currency: 'USD' }] }], '₹79.97'),
      ).toHaveLength(1);
    }
  });

  it('ignores a non-money number rendered without a currency marker', () => {
    // A weight of 40000 grams prints as 400.00 — but bare, so it never reaches the comparison.
    expect(
      reconcile(
        [{ items: [{ id: 'p', amount: 7997, weightGrams: 40000, currency: 'USD' }] }],
        'weight 400.00 kg and $79.97',
      ),
    ).toEqual([]);
  });

  it('reports an entity once even when several of its fields are money', () => {
    expect(
      reconcile(
        [{ items: [{ id: 'p', amount: 7997, fee: 100, currency: 'USD' }] }],
        '₹79.97 ₹1.00',
      ),
    ).toHaveLength(1);
  });
});
