import { describe, expect, it } from 'vitest';
import { appFindings } from './app-findings.js';

const call = (name: string, result: unknown) => ({
  id: 'x',
  name,
  args: {},
  result,
  isError: false,
});

/** From the merchant drives: what the page rendered and what the crawl saw never reached the report. */
describe('what a drive found beyond its clicks', () => {
  it('lists each page-versus-API mismatch and crawl anomaly once', () => {
    const reconcile = call('reticle_reconcile', {
      mismatches: [
        {
          entity: 'pay_NkT10005',
          field: 'currency',
          api: 'USD',
          rendered: '₹',
          why: 'currency marker',
        },
      ],
    });
    const crawl = call('reticle_crawl', {
      anomalies: [
        { kind: 'route-rendered-nothing', ref: 'e9', desc: 'link "Invoices"', detail: '/invoices' },
      ],
    });
    const lines = appFindings([reconcile, reconcile, crawl]);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('pay_NkT10005 currency — the API says USD, the page shows ₹');
    expect(lines[2]).toContain('CRAWL route-rendered-nothing: link "Invoices"');
  });

  it('adds nothing when nothing was found', () => {
    expect(appFindings([call('reticle_reconcile', { mismatches: [] })])).toEqual([]);
  });
});
