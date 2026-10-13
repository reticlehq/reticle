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
  KEY_REFUSED_LINE,
  RESULT_FIELD,
  ResultWord,
  buildReticleResult,
  changeResult,
  exploreResult,
  platformLine,
  replayResult,
  retitleResult,
  sessionResult,
  suiteResult,
} from './reticle-result.js';
import { buildSuiteVerdict } from '@/language/flows/decision.js';
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
      screenshots: ['/r1/a.jpg', '/r2/b.jpg', '/r3/c.jpg', '/r4/d.jpg'],
      platform: LINKED,
    });
    const lines = block.split('\n');
    expect(lines[0]).toBe(`**Reticle result: ${ResultWord.PROVED}** · 3 of 3 checks held`);
    expect(block).toContain('- Checks: 3 yes · 0 no · 0 undecided');
    expect(block).toContain('- Covered: checkout, login');
    // The headline already carries the check count, so the metrics do not repeat it.
    expect(block).toContain('- Metrics: 2 flows replayed · 4.2s');
    expect(block).toContain('- Evidence: /r1/a.jpg, /r2/b.jpg, /r3/c.jpg (+1 more)');
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
    expect(block).not.toContain('Metrics');
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

  // Persona drive (CI with a revoked key): the block said "Saved: the daemon syncs this run" and
  // `reticle verify` exited 0, while the sync had been refused.
  it('linked, but the platform refused the key at the last sync: says so, never "Saved"', () => {
    const dir = root();
    writeFileSync(
      join(dir, ReticleDir.CLOUD_LINK_FILE),
      JSON.stringify({ projectId: 'p', url: 'https://api.test', dashboardUrl: 'https://app.test' }),
    );
    writeFileSync(
      join(dir, ReticleDir.CLOUD_STATE_FILE),
      JSON.stringify({ lastError: 'status 401: invalid key' }),
    );
    const line = platformLine(dir, {}, 'r1');
    expect(line).toContain(KEY_REFUSED_LINE);
    expect(line).not.toContain('Saved');
    expect(line).not.toContain('/runs/r1');
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

describe('the block on a single replay and on a Harness drive', () => {
  const unlinked = (): string => mkdtempSync(join(tmpdir(), 'reticle-result-'));
  const replay = (status: string, extra: Record<string, unknown> = {}) =>
    ({
      name: 'checkout',
      status,
      steps: [{ step: 0, anchor: 'pay', ok: true, screenshot: { path: '/shots/0.jpg' } }],
      ...extra,
    }) as unknown as Parameters<typeof replayResult>[1];

  it('a replay that held is one proved check, one flow replayed, its time and screenshot', () => {
    const block = replayResult(unlinked(), replay('ok'), 1500, 'run-1');
    expect(block.split('\n')[0]).toBe(
      `**Reticle result: ${ResultWord.PROVED}** · 1 of 1 check held`,
    );
    expect(block).toContain('- Covered: checkout');
    expect(block).toContain('- Metrics: 1 flow replayed · 1.5s');
    expect(block).toContain('- Evidence: /shots/0.jpg');
  });

  it('a single replay says each fact once: no restated counts, and its screenshots by folder', () => {
    // The answer around this block already lists every step's screenshot path, so the block names
    // the run's folder once instead of repeating three long paths. Measured: the block was 340 of
    // a replay answer's tokens, 216 of them paths the steps above it already carried.
    const dir = '/private/var/folders/06/abc/T/project/.reticle/visual/runs/0b8f5c2e-4c1d';
    const steps = [0, 1, 2, 3, 4].map((i) => ({
      step: i,
      anchor: `a${String(i)}`,
      ok: true,
      screenshot: { path: `${dir}/000${String(i + 1)}-replay.jpg`, source: 'browser' },
    }));
    const block = replayResult(unlinked(), replay('ok', { steps }), 600, 'run-1');
    const lines = block.split('\n');
    expect(lines[0]).toContain(ResultWord.PROVED);
    expect(block).toContain(`- Evidence: 5 screenshots in ${dir}`);
    for (const s of steps) expect(block).not.toContain(s.screenshot.path);
    // One check: the headline says it all, so no per-word tally restates it.
    expect(block).not.toContain('- Checks:');
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(block.length - (lines.at(-1) ?? '').length).toBeLessThan(260);
  });

  it('screenshots from more than one folder are still listed by path', () => {
    const block = buildReticleResult({
      yes: 1,
      no: 0,
      undecided: 0,
      screenshots: ['/r1/a.jpg', '/r2/b.jpg'],
      platform: LINKED,
    });
    expect(block).toContain('- Evidence: /r1/a.jpg, /r2/b.jpg');
  });

  /*
   * Persona drive: `reticle_verify { action: "flows" }` answered `status: "unverifiable"` (a channel
   * contradicted the green) while its own block said "proved · 1 of 1 check held". One truth.
   */
  it('a suite whose green a channel contradicted is not proved, as its status says', () => {
    const contradicted = replay('ok', {
      steps: [
        {
          step: 0,
          anchor: 'sign in',
          ok: true,
          contradictions: [
            { kind: 'duplicate-request', counter: 'POST /api/login x2', detail: 'd' },
          ],
        },
      ],
    });
    const verdict = buildSuiteVerdict([{ replay: contradicted }]);
    expect(verdict.status).toBe('unverifiable');
    const block = suiteResult(
      unlinked(),
      verdict,
      [{ replay: contradicted, durationMs: 10 }],
      undefined,
    );
    expect(block.split('\n')[0]).toBe(
      `**Reticle result: ${ResultWord.NOT_PROVED}** · 1 of 1 check undecided`,
    );
  });

  it('a drifted replay is failed and names the flow; an unverifiable one is not proved', () => {
    expect(replayResult(unlinked(), replay('drift'), 10, undefined)).toContain(
      '- Did not hold: checkout',
    );
    const ok = replayResult(
      unlinked(),
      replay('ok', { unverifiable: { reason: 'r' } }),
      10,
      undefined,
    );
    expect(ok.split('\n')[0]).toContain(ResultWord.NOT_PROVED);
  });

  // Persona drives: one Harness run said "2 of 2 check(s) held" in its summary, "3 of 3" in its
  // block (the graded goal added on top) and another count on the dashboard. One count: the checks.
  it('a Harness drive counts its checks once, as its summary does, and how many journeys were replayed or driven', () => {
    const block = exploreResult(unlinked(), {
      checks: { held: 2, failed: 0, undecided: 0 },
      goals: [{ verified: Verified.YES }],
      journeys: [
        { title: 'Ana: pays', status: 'passed', by: 'replay' },
        { title: 'Ben: refunds', status: 'passed', by: 'model' },
      ],
    });
    expect(block.split('\n')[0]).toBe(
      `**Reticle result: ${ResultWord.PROVED}** · 2 of 2 checks held`,
    );
    expect(block).toContain('- Covered: Ana: pays, Ben: refunds');
    expect(block).toContain('1 journey replayed · 1 journey driven');
  });

  it("a plan's failed journey makes the block failed, though its checks held", () => {
    const block = exploreResult(unlinked(), {
      checks: { held: 1, failed: 0, undecided: 0 },
      goals: [],
      journeys: [{ title: 'Ana: pays', status: 'failed', by: 'model' }],
    });
    expect(block.split('\n')[0]).toContain(ResultWord.FAILED);
    expect(block.split('\n')[0]).toContain('1 of 1 journey(s) failed');
  });

  it("a plan's passed replay makes the block proved", () => {
    const block = exploreResult(unlinked(), {
      checks: { held: 0, failed: 0, undecided: 0 },
      goals: [],
      journeys: [{ title: 'Ana: pays', status: 'passed', by: 'replay' }],
    });
    expect(block.split('\n')[0]).toContain(`**Reticle result: ${ResultWord.PROVED}**`);
  });

  it('checks that held over a goal the drive did not reach are not proved', () => {
    const block = exploreResult(unlinked(), {
      checks: { held: 2, failed: 0, undecided: 0 },
      goals: [],
      goalMet: false,
    });
    expect(block.split('\n')[0]).toContain(ResultWord.NOT_PROVED);
    expect(block.split('\n')[0]).toContain('goal');
  });
});
