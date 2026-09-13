/**
 * `init` told people that `allowNonLocalhost: true` was enough. It is not.
 *
 * `connectionPolicy` in the browser SDK gates a non-local page on BOTH the flag and a pairing token:
 * with the flag and no token the SDK still refuses, and the refusal is page-side, so the daemon sees
 * silence and every `doctor` check stays green. The reporter who worked this out did it by grepping
 * our compiled `dist` inside their own `node_modules`, because our installer presented half the rule
 * as the whole rule.
 *
 * A setup step that exits 0 while leaving the user broken is the worst failure mode this repo has,
 * and instructions that are HALF right are exactly that step written in prose.
 */

import { describe, expect, it } from 'vitest';
import { htmlManual, nuxtManual } from './snippets.js';

/** Wherever the rule is stated, it has to be stated in full. */
function statesTheWholeRule(text: string): boolean {
  if (!text.includes('allowNonLocalhost')) return true;
  return /pairing token/i.test(text) && /token/.test(text);
}

describe('non-localhost guidance names the pairing token, not just the flag', () => {
  it('the plain-HTML recipe', () => {
    expect(statesTheWholeRule(htmlManual(4400, 'p1', 'tok'))).toBe(true);
  });

  it('the plain-HTML recipe with no token provisioned', () => {
    expect(statesTheWholeRule(htmlManual(4400, 'p1'))).toBe(true);
  });

  it('the Nuxt recipe', () => {
    expect(statesTheWholeRule(nuxtManual(4400, 'p1'))).toBe(true);
  });

  it('says where the token comes from, or the instruction is unusable', () => {
    expect(htmlManual(4400, 'p1')).toContain('~/.reticle/pairing-token');
  });
});
