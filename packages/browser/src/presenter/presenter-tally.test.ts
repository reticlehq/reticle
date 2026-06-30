import { describe, expect, it } from 'vitest';
import { countVerdicts, renderTally, type TallyCounts } from './presenter-tally.js';
import { Presenter } from './presenter.js';

describe('countVerdicts', () => {
  it('counts pass/fail results and ignores rows with no verdict', () => {
    expect(countVerdicts([{ result: 'pass' }, {}, { result: 'fail' }, { result: 'pass' }])).toEqual(
      { passes: 2, fails: 1 },
    );
  });

  it('returns zeros for an empty log', () => {
    expect(countVerdicts([])).toEqual({ passes: 0, fails: 0 });
  });
});

describe('renderTally', () => {
  function el(): HTMLElement {
    const d = document.createElement('div');
    d.setAttribute('hidden', '');
    return d;
  }
  const zero: TallyCounts = { passes: 0, fails: 0 };

  it('stays hidden until a verdict lands', () => {
    const e = el();
    const out = renderTally(e, [{}], zero);
    expect(e.hasAttribute('hidden')).toBe(true);
    expect(out).toEqual({ passes: 0, fails: 0 });
  });

  it('shows ✓N ✗M once verdicts exist and reports the new counts', () => {
    const e = el();
    const out = renderTally(e, [{ result: 'pass' }, { result: 'pass' }, { result: 'fail' }], zero);
    expect(e.hasAttribute('hidden')).toBe(false);
    expect(e.querySelector('.reticle-t-pass')?.textContent).toBe('✓ 2');
    expect(e.querySelector('.reticle-t-fail')?.textContent).toBe('✗ 1');
    expect(out).toEqual({ passes: 2, fails: 1 });
  });

  it('pops only the side that grew since the previous paint', () => {
    const e = el();
    // prev had 1 pass / 1 fail; now 2 pass / 1 fail → only the pass side bumps.
    renderTally(e, [{ result: 'pass' }, { result: 'pass' }, { result: 'fail' }], {
      passes: 1,
      fails: 1,
    });
    expect(e.querySelector('.reticle-t-pass')?.getAttribute('data-bump')).toBe('1');
    expect(e.querySelector('.reticle-t-fail')?.getAttribute('data-bump')).toBeNull();
  });

  it('dims a zero side', () => {
    const e = el();
    renderTally(e, [{ result: 'pass' }], zero);
    expect(e.querySelector('.reticle-t-fail')?.getAttribute('data-z')).toBe('1');
    expect(e.querySelector('.reticle-t-pass')?.getAttribute('data-z')).toBeNull();
  });
});

describe('Presenter — live header verdict tally', () => {
  const tally = (): HTMLElement | null => document.querySelector('[data-reticle-tally]');

  it('stays hidden until a verdict lands, then counts ✓/✗ live (incl. a deferred stamp)', () => {
    document.body.innerHTML = '';
    const p = new Presenter({});
    p.mount();
    p.log('read', 'just looking'); // no verdict → hidden
    expect(tally()?.hasAttribute('hidden')).toBe(true);
    p.log('act', 'click Save', 'pass'); // passing verdict → ✓ 1
    expect(tally()?.hasAttribute('hidden')).toBe(false);
    expect(tally()?.querySelector('.reticle-t-pass')?.textContent).toBe('✓ 1');
    p.log('act', 'submit', 'fail');
    p.log('act', 'retry')?.result('pass'); // a DEFERRED stamp updates the score too
    expect(tally()?.querySelector('.reticle-t-pass')?.textContent).toBe('✓ 2');
    expect(tally()?.querySelector('.reticle-t-fail')?.textContent).toBe('✗ 1');
    p.destroy();
  });
});
