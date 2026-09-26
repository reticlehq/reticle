import { ElementState } from '@reticlehq/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { isVisible } from './a11y.js';
import { matchQuery, runQuery } from './query.js';

describe('visibility inside native details', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps the summary and its descendants visible while details is closed', () => {
    document.body.innerHTML =
      '<details><summary><span>Connection status and setup</span></summary>' +
      '<h2>Connected to staging</h2></details>';
    const summaryText = document.querySelector('summary span');
    const heading = document.querySelector('h2');
    if (null === summaryText || null === heading) throw new Error('details fixture is incomplete');

    expect(isVisible(summaryText)).toBe(true);
    expect(isVisible(heading)).toBe(false);
  });

  it('reports collapsed content hidden and matches it as visible only after expansion', () => {
    document.body.innerHTML =
      '<details><summary>Connection status and setup</summary>' +
      '<h2>Connected to staging</h2></details>';
    const details = document.querySelector('details');
    if (null === details) throw new Error('details fixture is incomplete');
    const query = { role: 'heading', name: 'Connected to staging' };

    expect(runQuery(query).elements[0]?.visible).toBe(false);
    expect(matchQuery(query, ElementState.VISIBLE).count).toBe(0);

    details.open = true;

    expect(runQuery(query).elements[0]?.visible).toBe(true);
    expect(matchQuery(query, ElementState.VISIBLE).count).toBe(1);
  });
});
