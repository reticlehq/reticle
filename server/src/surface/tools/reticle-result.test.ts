/**
 * The block an agent ends with. One format whatever answered — a suite, a changed-file check, a
 * session drive — so the user reads the same three verdict words every time, and an `unknown` can
 * never arrive dressed as a pass.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRIAL_OFFER } from '@reticlehq/core/hud';
import { ReticleDir, Verified } from '@reticlehq/core';
import {
  RESULT_FIELD,
  ResultWord,
  buildReticleResult,
  changeResult,
  platformLine,
  retitleResult,
  sessionResult,
} from './reticle-result.js';
import type { JournalAction } from '@reticlehq/core';
import type { ToolDeps } from './tool-kit.js';
import { CONNECT } from './platform-moment.js';

const LINKED = '- Run on the dashboard: https://app.test/runs/r1';

describe('the Reticle result block', () => {
  it('all checks held: proved, with the counts, what was covered, the metrics and the evidence', () => {
    const block = buildReticleResult({
      yes: 3,
      no: 0,
      undecided: 0,
      covered: ['checkout', 'login'],
      flowsReplayed: 2,
      wallMs: 4200,
      screenshots: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'],
      platform: LINKED,
    });
    const lines = block.split('\n');
    expect(lines[0]).toBe(`**Reticle result: ${ResultWord.PROVED}** · 3 of 3 checks held`);
    expect(block).toContain('- Checks: 3 yes · 0 no · 0 undecided');
    expect(block).toContain('- Covered: checkout, login');
    expect(block).toContain('- Metrics: 3 checks · 2 flows replayed · 4.2s');
    expect(block).toContain('- Evidence: a.jpg, b.jpg, c.jpg (+1 more)');
    // The platform line is the last line, said once.
    expect(lines.at(-1)).toBe(LINKED);
    expect(block.split(LINKED)).toHaveLength(2);
  });

  it('an undecided check is NOT proved, even when every decided one held', () => {
    const block = buildReticleResult({ yes: 2, no: 0, undecided: 1, platform: LINKED });
    expect(block.split('\n')[0]).toBe(
      `**Reticle result: ${ResultWord.NOT_PROVED}** · 1 of 3 checks undecided`,
    );
  });

  it('nothing checked is not proved, and says so', () => {
    const block = buildReticleResult({ yes: 0, no: 0, undecided: 0, platform: LINKED });
    expect(block.split('\n')[0]).toBe(
      `**Reticle result: ${ResultWord.NOT_PROVED}** · nothing was checked`,
    );
  });

  it('a check that did not hold is failed and names what failed', () => {
    const block = buildReticleResult({
      yes: 2,
      no: 1,
      undecided: 0,
      failed: ['checkout'],
      platform: LINKED,
    });
    expect(block.split('\n')[0]).toBe(
      `**Reticle result: ${ResultWord.FAILED}** · 1 of 3 checks did not hold`,
    );
    expect(block).toContain('- Did not hold: checkout');
  });

  it('leaves out a metric it did not measure rather than printing a zero', () => {
    const block = buildReticleResult({ yes: 1, no: 0, undecided: 0, platform: LINKED });
    expect(block).toContain('- Metrics: 1 check');
    expect(block).not.toContain('replayed');
    expect(block).not.toContain('Evidence');
    expect(block).not.toContain('token');
  });

  it('a stated verdict wins over the counts, with its reason', () => {
    const block = buildReticleResult({ yes: 2, no: 0, undecided: 0, platform: LINKED });
    const retitled = retitleResult(block, Verified.NO, 'channels disagreed during the replay');
    expect(retitled.split('\n')[0]).toBe(
      `**Reticle result: ${ResultWord.FAILED}** · channels disagreed during the replay`,
    );
    expect(retitled.split('\n').slice(1)).toEqual(block.split('\n').slice(1));
    expect(retitleResult(block, Verified.UNKNOWN, 'x').split('\n')[0]).toContain(
      ResultWord.NOT_PROVED,
    );
  });
});

describe('the platform line', () => {
  const root = (): string => mkdtempSync(join(tmpdir(), 'reticle-result-'));

  it('linked with a dashboard: the run on the dashboard', () => {
    const dir = root();
    writeFileSync(
      join(dir, ReticleDir.CLOUD_LINK_FILE),
      JSON.stringify({
        projectId: 'p',
        url: 'https://api.test',
        dashboardUrl: 'https://app.test/x',
      }),
    );
    expect(platformLine(dir, {}, 'r1')).toBe('- Run on the dashboard: https://app.test/runs/r1');
    expect(platformLine(dir, {})).toBe('- On the dashboard: https://app.test/x');
  });

  it('not linked: what the platform adds, the trial, and the one command', () => {
    const dir = root();
    mkdirSync(dir, { recursive: true });
    const line = platformLine(dir, {}, 'r1');
    expect(line).toContain('history');
    expect(line).toContain('your team');
    expect(line).toContain('Reticle Harness');
    expect(line).toContain(TRIAL_OFFER);
    expect(line).toContain(CONNECT);
    expect(line.split('\n')).toHaveLength(1);
  });

  it('linked by a key in the environment, with no dashboard named: says it syncs, never pitches', () => {
    const line = platformLine(root(), { RETICLE_API_KEY: 'rk_x' });
    expect(line).not.toContain(TRIAL_OFFER);
    expect(line).toContain('Reticle platform');
  });
});

const verdict = (claim: string, verified: Verified): JournalAction =>
  ({
    tool: 'reticle_act_and_wait',
    at: 1,
    args: {},
    effect: { claim, verified },
  }) as unknown as JournalAction;

describe('the block on the answers an agent ends with', () => {
  const unlinked = (): string => mkdtempSync(join(tmpdir(), 'reticle-result-'));

  it('a session end counts every verdict, and nothing-declared is undecided, never held', () => {
    const root = unlinked();
    const block = sessionResult(
      {
        reticleRoot: root,
        sessions: { resolve: () => ({ id: 's1', projectId: undefined }) },
      } as unknown as ToolDeps,
      's1',
      [
        verdict('badge reads checked in', Verified.YES),
        verdict('list shows the row', Verified.NO),
        verdict('saved', Verified.NO_FAULT),
        verdict('toast', Verified.UNKNOWN),
      ],
      65_000,
    );
    expect(block.split('\n')[0]).toContain(ResultWord.FAILED);
    expect(block).toContain('- Checks: 1 yes · 1 no · 2 undecided');
    expect(block).toContain('- Covered: badge reads checked in');
    expect(block).toContain('- Did not hold: list shows the row');
    expect(block).toContain('1m 5s');
    expect(block).toContain(TRIAL_OFFER);
  });

  it('a change verdict decided above the suite replaces the suite block, and nests none', () => {
    const suiteBlock = buildReticleResult({ yes: 2, no: 0, undecided: 0, platform: LINKED });
    const out = changeResult(unlinked(), {
      verified: Verified.NO,
      because: 'channels disagreed during the replay (write-failed)',
      suite: { status: 'pass', [RESULT_FIELD]: suiteBlock },
    }) as Record<string, unknown>;
    expect(String(out[RESULT_FIELD]).split('\n')[0]).toBe(
      `**Reticle result: ${ResultWord.FAILED}** · channels disagreed during the replay (write-failed)`,
    );
    expect(out['suite']).toEqual({ status: 'pass' });
  });

  it('a change nothing covers: not proved, with the reason, and still the platform line', () => {
    const out = changeResult(unlinked(), {
      verified: Verified.UNKNOWN,
      because: 'no saved flow covers these files',
    }) as Record<string, unknown>;
    const block = String(out[RESULT_FIELD]);
    expect(block.split('\n')[0]).toContain(ResultWord.NOT_PROVED);
    expect(block).toContain(CONNECT);
  });
});
