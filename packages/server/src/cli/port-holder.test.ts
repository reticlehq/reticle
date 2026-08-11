import { describe, expect, it } from 'vitest';
import { parsePortHolder, describeForeignHolder } from './port-holder.js';

/**
 * Naming the process that holds the port.
 *
 * `doctor` is what a user runs when the agent cannot reach the bridge, and the commonest real cause
 * is that something else is on 4400. It already stopped saying "nothing is listening" for that case
 * — it says "held by another process" — but it does not say WHICH, so the reader's next move is a
 * shell command they have to know. Worse, the obvious one (`lsof -ti tcp:4400 | xargs kill -9`)
 * kills the agent's own `reticle mcp` proxy, because that proxy holds a CLIENT connection to the
 * port and `-ti` does not filter to listeners.
 *
 * So the field selector below is `-sTCP:LISTEN`, and the parser is pure and tested against real
 * `lsof -F pc` output rather than trusted.
 */
describe('parsePortHolder', () => {
  it('reads pid and command from lsof -F pc output', () => {
    expect(parsePortHolder('p90502\ncnode\n')).toEqual({ pid: 90502, command: 'node' });
  });

  it('takes the FIRST listener when several are reported', () => {
    // Dual-stack (IPv4 + IPv6) reports the same process twice; a second `p` record starts a new one.
    expect(parsePortHolder('p90502\ncnode\np90777\ncother\n')).toEqual({
      pid: 90502,
      command: 'node',
    });
  });

  it('survives a command with spaces', () => {
    expect(parsePortHolder('p12\ncPython 3.12\n')?.command).toBe('Python 3.12');
  });

  it('returns null for empty output — nothing is listening, which is not an error', () => {
    expect(parsePortHolder('')).toBeNull();
    expect(parsePortHolder('\n')).toBeNull();
  });

  it('returns null rather than guessing when the pid is not a number', () => {
    expect(parsePortHolder('pnotanumber\ncnode\n')).toBeNull();
  });

  it('returns null when lsof reported a pid but no command', () => {
    // Half an answer is not an answer: "(pid 90502, undefined)" is worse than saying nothing.
    expect(parsePortHolder('p90502\n')).toBeNull();
  });
});

describe('describeForeignHolder', () => {
  it('names the pid and command, and does not suggest the command that kills the agent', () => {
    const text = describeForeignHolder(4400, { pid: 90502, command: 'node' });
    expect(text).toContain('4400');
    expect(text).toContain('90502');
    expect(text).toContain('node');
    // The trap from the field: `lsof -ti tcp:4400 | xargs kill -9` also kills `reticle mcp`.
    expect(text).not.toMatch(/-ti\b/);
  });

  it('falls back to the un-named message when the holder could not be identified', () => {
    const text = describeForeignHolder(4400, null);
    expect(text).toContain('another process');
    expect(text).not.toContain('pid');
  });
});
