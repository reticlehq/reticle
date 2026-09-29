import { describe, expect, it } from 'vitest';
import { wrapForTerminal } from './terminal-wrap.js';

const lines = (s: string) => s.split('\n');

describe('wrapForTerminal', () => {
  it('leaves everything alone when there is no terminal width', () => {
    const long = 'word '.repeat(60).trim();
    expect(wrapForTerminal(long, undefined)).toBe(long);
  });

  it('wraps a long sentence at word boundaries within the width', () => {
    const out = wrapForTerminal('one two three four five six seven eight nine ten', 20);
    for (const l of lines(out)) expect(l.length).toBeLessThanOrEqual(20);
    expect(out.replaceAll('\n', ' ')).toBe('one two three four five six seven eight nine ten');
  });

  it('keeps the line’s indent on every wrapped line', () => {
    const out = wrapForTerminal('   alpha beta gamma delta epsilon zeta', 20);
    for (const l of lines(out)) expect(l.startsWith('   ')).toBe(true);
  });

  it('hangs continuation lines under the text of a numbered item', () => {
    const out = lines(wrapForTerminal('1. alpha beta gamma delta epsilon zeta eta', 20));
    expect(out[0]?.startsWith('1. alpha')).toBe(true);
    for (const l of out.slice(1)) expect(l.startsWith('   ') && !l.startsWith('    ')).toBe(true);
  });

  it('hangs under a `why:` label', () => {
    const out = lines(wrapForTerminal('   why: alpha beta gamma delta epsilon zeta', 24));
    for (const l of out.slice(1)) expect(l.startsWith('        ')).toBe(true);
  });

  it('hangs under a ✓ item', () => {
    const out = lines(wrapForTerminal('  ✓ 10 more agents: VS Code, Zed, Warp, Kiro, Amp', 24));
    for (const l of out.slice(1)) expect(l.startsWith('    ') && !l.startsWith('     ')).toBe(true);
  });

  // A wrapped command is one nobody can paste.
  it('never wraps a command line', () => {
    const cmd =
      '  npx @reticlehq/server feedback --agent --kind <bug|gap|ambiguity> "what happened"   (agents)';
    expect(wrapForTerminal(cmd, 40)).toBe(cmd);
  });

  // `in /a/very/long/path` wrapped as `in` alone, then the path: the label lost its value.
  it('leaves a line alone when it holds a word too wide to fit anyway', () => {
    const line = '  in /private/tmp/a/very/long/project/path/that/cannot/break';
    expect(wrapForTerminal(line, 30)).toBe(line);
  });

  it('wraps each line of a multi-line block on its own, blank lines kept', () => {
    const out = wrapForTerminal('short\n\nalpha beta gamma delta epsilon', 12);
    expect(lines(out).slice(0, 2)).toEqual(['short', '']);
  });
});
