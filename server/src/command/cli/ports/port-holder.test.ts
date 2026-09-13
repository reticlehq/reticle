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

  it('does not claim to know whose process it is when the lookup found nothing', () => {
    const text = describeForeignHolder(4400, null);
    expect(text).toContain('could not identify');
    expect(text).not.toContain('pid');
    // The null case has no evidence for this, and it is the likeliest thing to be wrong.
    expect(text, 'an unknown holder is not a known stranger').not.toContain(
      'is not a Reticle daemon',
    );
  });
});

/**
 * Our own wedged daemon must not be reported as somebody else's process.
 *
 * Found by stress-testing: `SIGSTOP` a daemon and it keeps accepting TCP while never answering
 * `/status`, so it classifies FOREIGN. Measured on :4411 with `~/.reticle/daemon-4411.pid` holding
 * the frozen process's exact pid:
 *
 *   reticle doctor → 'port 4411 is held by pid 65704 ("node"), which is not a Reticle daemon'
 *
 * It was ours. The advice that follows sends the reader hunting a stranger that does not exist and
 * never mentions the fix that works. Worse, `reticle status` reported `running: true` for the same
 * daemon at the same instant — the two commands contradicting each other about one process.
 */
describe('a wedged daemon of our own', () => {
  it('is named as ours when the holder pid is the pid we recorded', () => {
    const msg = describeForeignHolder(4411, { pid: 65704, command: 'node' }, 65704);
    expect(msg).toContain('YOUR Reticle daemon');
    expect(msg).toContain('not responding');
    expect(msg, 'do not call our own daemon a stranger').not.toContain('is not a Reticle daemon');
    expect(msg, 'name the fix that works').toContain('reticle stop');
  });

  it('still calls a genuine stranger a stranger', () => {
    const msg = describeForeignHolder(4411, { pid: 999, command: 'python' }, 65704);
    expect(msg).toContain('is not a Reticle daemon');
    expect(msg).toContain('999');
  });

  /**
   * "Stop that process" is a description of an outcome, not a way to reach it, and the reader
   * supplying their own way to reach it is how the `-ti` pipeline gets typed. Now that a command
   * exists for it (#114), name it.
   */
  it('names the command that frees the port instead of leaving the reader to invent one', () => {
    const msg = describeForeignHolder(4411, { pid: 999, command: 'python' }, 65704);
    expect(msg).toContain('reticle kill');
    expect(msg).not.toMatch(/-ti\b/);
  });

  it('keeps the old wording when we have no recorded pid to compare', () => {
    expect(describeForeignHolder(4411, { pid: 999, command: 'python' }, null)).toContain(
      'is not a Reticle daemon',
    );
  });

  /**
   * The Windows case, which is a large share of users and never runs in CI — the
   * `windows` job builds and unit-tests, and no daemon ever starts on it.
   *
   * There is no `lsof` there, so the holder lookup ALWAYS returns null and the null branch is the
   * only one a Windows user can ever reach. It asserted "is not a Reticle daemon" — with no
   * evidence, on the command people run because something is already broken, in the one situation
   * (FOREIGN: accepts TCP, never answers /status) whose commonest cause is our own wedged daemon.
   */
  it('names our recorded pid when the holder cannot be looked up at all', () => {
    const msg = describeForeignHolder(4411, null, 65704);
    expect(msg, 'do not assert what the null case cannot know').not.toContain(
      'is not a Reticle daemon',
    );
    expect(msg, 'the pid we recorded is the one lead we have').toContain('65704');
    expect(msg, 'name the fix that works').toContain('reticle stop');
  });
});
