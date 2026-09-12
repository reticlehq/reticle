import { describe, expect, it } from 'vitest';
import { formatBuddyStatus } from './buddy-status.js';

describe('formatBuddyStatus (buddy channel)', () => {
  it('says the reassuring thing briefly when everything is nominal', () => {
    expect(formatBuddyStatus({ total: 41, passing: 41, deviations: [], quarantined: [] })).toBe(
      '✓ 41/41 flows nominal',
    );
  });

  it('NAMES the deviation — a bare count would force the human to go digging', () => {
    const line = formatBuddyStatus({
      total: 41,
      passing: 40,
      deviations: ['billing'],
      quarantined: [],
    });
    expect(line).toContain('billing');
    expect(line).toContain('1 deviation');
    expect(line).not.toContain('deviations'); // singular when there is one
  });

  it('stays ONE line when many flows deviate (names a couple, collapses the rest)', () => {
    const line = formatBuddyStatus({
      total: 41,
      passing: 36,
      deviations: ['a', 'b', 'c', 'd', 'e'],
      quarantined: [],
    });
    expect(line).toContain('a, b');
    expect(line).toContain('+3 more');
    expect(line.includes('\n')).toBe(false);
  });

  it('surfaces flaky quarantine without letting it read as a failure', () => {
    const clean = formatBuddyStatus({
      total: 41,
      passing: 41,
      deviations: [],
      quarantined: ['x', 'y'],
    });
    expect(clean.startsWith('✓')).toBe(true); // quarantined flakes do not turn the line red
    expect(clean).toContain('2 flaky quarantined');
  });

  it('handles an empty project without dividing by zero or lying', () => {
    expect(formatBuddyStatus({ total: 0, passing: 0, deviations: [], quarantined: [] })).toBe(
      '✓ 0/0 flows nominal',
    );
  });
});
