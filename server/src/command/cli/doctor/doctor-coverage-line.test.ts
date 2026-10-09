import { describe, expect, it } from 'vitest';
import { coverageLines } from './doctor-coverage-line.js';

describe('doctor coverage rows', () => {
  it('prints covered of total, what is missing, and the prompt to paste', () => {
    const lines = coverageLines({
      coverage: [
        {
          url: 'http://localhost:3000/',
          covered: 6,
          total: 8,
          missing: [{ capability: 'file:line source mapping' }],
          notSeenYet: ['stable test ids'],
          prompt:
            'Read https://reticle.sh/SKILL.md, then improve…\nReport the coverage line it prints.',
        },
      ],
    });
    expect(lines[0]).toContain('6/8 at http://localhost:3000/');
    expect(lines[0]).toContain('missing: file:line source mapping');
    expect(lines[0]).toContain('not seen yet: stable test ids');
    expect(lines.join('\n')).toContain('Report the coverage line it prints.');
  });

  it('says the Harness gate in the sentence a refused drive says', () => {
    const reason =
      'Harness unlocks at 80% instrumentation. This app is at 75%: missing stable test ids.';
    const lines = coverageLines({
      coverage: [{ covered: 6, total: 8, harnessGate: { percent: 75, unlocked: false, reason } }],
    });
    expect(lines[1]).toBe(`    ${reason}`);
  });

  it('prints nothing for a daemon too old to report coverage', () => {
    expect(coverageLines({ running: true })).toEqual([]);
  });
});
