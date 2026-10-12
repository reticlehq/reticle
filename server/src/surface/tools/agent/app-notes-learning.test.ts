import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { addAppNote, readAppNotes } from './app-notes.js';
import { learnFromVerdict, resetAppNoteLearning } from './app-notes-learning.js';
import { forTheAgent } from './for-the-agent.js';
import { type NoticeFold, resetNotices } from './notices.js';

const FOLD: NoticeFold = {
  advisories: [],
  notices: 'notices',
  next: 'next',
  warning: 'warning',
  onceWarnings: new Map(),
};

let root = '';
beforeEach(() => {
  resetAppNoteLearning();
  resetNotices();
  root = mkdtempSync(join(tmpdir(), 'app-notes-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const caseMiss = {
  verified: 'no',
  because: 'b',
  verdict: { pass: false, caseOnlyMiss: true, evidence: { caseMiss: 'Trial' } },
};
const roleMiss = {
  verified: 'no',
  because: 'b',
  verdict: {
    pass: false,
    evidence: { nearestByName: [{ ref: 'e7', role: 'generic', name: 'Ask a question' }] },
  },
};
const green = { verified: 'yes', because: 'b', verdict: { pass: true } };

describe('app notes are learned only from a fix that then passed', () => {
  it('a case miss followed by a passing check that used the shown case becomes a note', () => {
    expect(learnFromVerdict('a', { until: { kind: 'text', contains: 'trial' } }, caseMiss)).toBe(
      undefined,
    );
    const note = learnFromVerdict('a', { until: { kind: 'text', contains: 'Trial' } }, green);
    expect(note).toContain('this app writes "Trial"');
  });

  it('a role miss followed by a passing check by label becomes a note', () => {
    learnFromVerdict('a', {}, roleMiss);
    const note = learnFromVerdict(
      'a',
      { until: { kind: 'element', query: { label: 'Ask a question' } } },
      green,
    );
    expect(note).toContain('"Ask a question" is a generic here');
  });

  it('a pass that did NOT use the fix confirms nothing — a guess never becomes lore', () => {
    learnFromVerdict('a', {}, caseMiss);
    expect(learnFromVerdict('a', { until: { kind: 'signal', name: 'x' } }, green)).toBeUndefined();
  });

  it('another agent session does not confirm this one’s candidate', () => {
    learnFromVerdict('a', {}, caseMiss);
    expect(learnFromVerdict('b', { until: { contains: 'Trial' } }, green)).toBeUndefined();
  });
});

describe('a note can never make a check pass', () => {
  it('a red verdict stays red with every note on disk, and notes arrive only as notices', () => {
    addAppNote(root, 'this app writes "Trial"');
    addAppNote(root, '"Ask a question" is a generic here');
    expect(readAppNotes(root)).toHaveLength(2);
    const out = forTheAgent({
      name: ReticleTool.ACT_AND_WAIT,
      args: { until: { kind: 'text', contains: 'trial' } },
      result: caseMiss,
      attach: 'agent',
      root,
      fold: FOLD,
    }) as Record<string, unknown>;
    expect(out['verified']).toBe('no');
    expect(out['verdict']).toEqual(caseMiss.verdict);
    expect(out['because']).toBe('b');
    const notices = out['notices'] as string[];
    expect(notices).toContain('App note: this app writes "Trial"');
  });
});
