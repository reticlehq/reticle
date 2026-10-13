import { describe, expect, it } from 'vitest';
import { subjectOf } from './registry.js';

/*
 * Plan-run artifacts carried their subject URL with `__reticle_session=…` three times: the marks
 * Reticle puts on a tab to adopt it are not part of the app's address.
 */
describe('the subject a run names', () => {
  it('is the app address, without the marks Reticle put on the tab', () => {
    const subject = subjectOf({
      id: 's1',
      url: 'http://localhost:5173/saved-items?__reticle_session=l1&tab=2&__reticle_session=l1&__reticle_project=shop',
    });
    expect(subject.locator).toBe('http://localhost:5173/saved-items?tab=2');
  });
});
