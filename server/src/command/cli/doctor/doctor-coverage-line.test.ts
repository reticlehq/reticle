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
            'Read https://docs.reticle.sh/skill.md, then improve…\nReport the coverage line it prints.',
        },
      ],
    });
    expect(lines[0]).toContain('6/8 at http://localhost:3000/');
    expect(lines[0]).toContain('missing: file:line source mapping');
    expect(lines[0]).toContain('not seen yet: stable test ids');
    expect(lines.join('\n')).toContain('Report the coverage line it prints.');
  });

  it('prints no Harness lock line, even for an older daemon that still sends one', () => {
    const reason = 'Harness unlocks at 80% instrumentation. This app is at 75%.';
    const lines = coverageLines({
      coverage: [{ covered: 6, total: 8, harnessGate: { percent: 75, unlocked: false, reason } }],
    });
    expect(lines).toHaveLength(1);
  });

  it('prints nothing for a daemon too old to report coverage', () => {
    expect(coverageLines({ running: true })).toEqual([]);
  });
});
