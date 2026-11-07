import { describe, expect, it } from 'vitest';
import { JOURNAL_FILE_VERSION, Verified, type JournalAction } from '@reticlehq/core';
import { RUN_IDLE_LIMIT_MS, RunLedger, type RunIdentity } from './run-ledger.js';

const IDENTITY_A: RunIdentity = { sessionId: 'session-a', root: '/repo/worktree-a' };
const IDENTITY_B: RunIdentity = { sessionId: 'session-b', root: '/repo/worktree-a' };
const IDENTITY_A_ROOT_B: RunIdentity = { sessionId: 'session-a', root: '/repo/worktree-b' };

const verdict = (
  claim: string,
  verified: Verified,
  extra: Record<string, unknown> = {},
): JournalAction => ({
  v: JOURNAL_FILE_VERSION,
  actionId: `a-${claim}`,
  tool: 'reticle_act',
  args: {},
  effect: { claim, verified, ...extra },
  tRange: { from: 0, to: 0 },
  at: 0,
});

describe('the run ledger', () => {
  it('is empty until an identity starts a run and takes a report only once', () => {
    const ledger = new RunLedger();
    expect(ledger.isEmpty(IDENTITY_A)).toBe(true);
    ledger.begin(1_000, IDENTITY_A);
    ledger.verdict(verdict('task shows', Verified.YES), IDENTITY_A);
    ledger.after(1_500, IDENTITY_A);
    expect(ledger.isEmpty(IDENTITY_A)).toBe(false);
    const report = ledger.take(4_000, IDENTITY_A);
    expect(report.wallMs).toBe(3_000);
    expect(report.firstVerdictMs).toBe(500);
    expect(ledger.isEmpty(IDENTITY_A)).toBe(true);
  });

  it('isolates same-session runs across different roots', () => {
    const ledger = new RunLedger();
    ledger.begin(0, IDENTITY_A);
    ledger.verdict(verdict('worktree A claim', Verified.YES), IDENTITY_A);
    ledger.begin(100, IDENTITY_A_ROOT_B);
    ledger.verdict(verdict('worktree B claim', Verified.NO), IDENTITY_A_ROOT_B);

    expect(ledger.take(200, IDENTITY_A_ROOT_B).claims).toEqual([
      expect.objectContaining({ claim: 'worktree B claim', verified: Verified.NO }),
    ]);
    expect(ledger.take(200, IDENTITY_A).claims).toEqual([
      expect.objectContaining({ claim: 'worktree A claim', verified: Verified.YES }),
    ]);
  });

  it('isolates different sessions that use the same root', () => {
    const ledger = new RunLedger();
    ledger.begin(0, IDENTITY_A);
    ledger.verdict(verdict('session A claim', Verified.YES), IDENTITY_A);
    ledger.begin(100, IDENTITY_B);
    ledger.verdict(verdict('session B claim', Verified.NO), IDENTITY_B);

    expect(ledger.take(200, IDENTITY_A).claims.map((claim) => claim.claim)).toEqual([
      'session A claim',
    ]);
    expect(ledger.take(200, IDENTITY_B).claims.map((claim) => claim.claim)).toEqual([
      'session B claim',
    ]);
  });

  it('does not let unscoped actions receive a fallback run', () => {
    const ledger = new RunLedger();
    ledger.begin(0, IDENTITY_A);
    ledger.begin(100, IDENTITY_B);
    ledger.verdict(verdict('unscoped action', Verified.YES), IDENTITY_A_ROOT_B);
    ledger.flowSaved('unscoped flow', IDENTITY_A_ROOT_B);
    ledger.replayed('unscoped replay', Verified.NO, IDENTITY_A_ROOT_B);

    expect(ledger.take(200, IDENTITY_A_ROOT_B).claims).toEqual([]);
    expect(ledger.take(200, IDENTITY_A_ROOT_B).flows.replayed).toEqual([]);
    expect(ledger.isEmpty(IDENTITY_A)).toBe(false);
    expect(ledger.isEmpty(IDENTITY_B)).toBe(false);
  });

  it('takes only the requested identity', () => {
    const ledger = new RunLedger();
    ledger.begin(0, IDENTITY_A);
    ledger.verdict(verdict('from A', Verified.YES), IDENTITY_A);
    ledger.begin(100, IDENTITY_B);
    ledger.verdict(verdict('from B', Verified.NO), IDENTITY_B);

    expect(ledger.take(1_000, IDENTITY_A).claims.map((claim) => claim.claim)).toEqual(['from A']);
    expect(ledger.isEmpty(IDENTITY_A)).toBe(true);
    expect(ledger.isEmpty(IDENTITY_B)).toBe(false);
    expect(ledger.take(2_000, IDENTITY_B).claims.map((claim) => claim.claim)).toEqual(['from B']);
  });

  it('drops an identity run after the idle limit', () => {
    const ledger = new RunLedger();
    ledger.begin(0, IDENTITY_A);
    ledger.verdict(verdict('never reported', Verified.NO), IDENTITY_A);
    ledger.begin(RUN_IDLE_LIMIT_MS - 1, IDENTITY_B);
    expect(ledger.isEmpty(IDENTITY_A)).toBe(false);
    ledger.begin(RUN_IDLE_LIMIT_MS + 1, IDENTITY_B);
    expect(ledger.isEmpty(IDENTITY_A)).toBe(true);
    expect(ledger.isEmpty(IDENTITY_B)).toBe(false);
  });

  it('lists claims with evidence and the failed ones as caught', () => {
    const ledger = new RunLedger();
    ledger.begin(0, IDENTITY_A);
    ledger.verdict(
      verdict('the request carries seats: 5', Verified.NO, {
        observed: 'POST /api/members sent seats: 4',
        source: 'src/workspace.ts:220',
      }),
      IDENTITY_A,
    );
    ledger.verdict(
      verdict('5 seats shows', Verified.YES, { source: 'src/workspace.ts:230' }),
      IDENTITY_A,
    );
    const report = ledger.take(10, IDENTITY_A);
    expect(report.verified).toBe(Verified.NO);
    expect(report.claims).toEqual([
      {
        claim: 'the request carries seats: 5',
        verified: Verified.NO,
        evidence: 'saw POST /api/members sent seats: 4',
      },
      { claim: '5 seats shows', verified: Verified.YES, evidence: 'src/workspace.ts:230' },
    ]);
    expect(report.caught).toEqual(['the request carries seats: 5']);
  });

  it('does not count a passive no that a later yes of the same claim superseded', () => {
    const ledger = new RunLedger();
    ledger.begin(0, IDENTITY_A);
    ledger.verdict(verdict('saved', Verified.NO, { declaredBeforeActing: false }), IDENTITY_A);
    ledger.verdict(verdict('saved', Verified.YES), IDENTITY_A);
    const report = ledger.take(10, IDENTITY_A);
    expect(report.claims.map((claim) => claim.verified)).toEqual([Verified.YES]);
    expect(report.verified).toBe(Verified.YES);
  });

  it('keeps flows, replayed verdicts, and memory scoped to one identity', () => {
    const ledger = new RunLedger();
    ledger.begin(0, IDENTITY_A);
    ledger.flowSaved('invite', IDENTITY_A);
    ledger.flowSaved('invite', IDENTITY_A);
    ledger.replayed('invite', Verified.NO, IDENTITY_A);
    ledger.memoryWritten(IDENTITY_A);
    ledger.memoryRead(['the composer is a contenteditable'], IDENTITY_A);
    ledger.memoryRead(['the composer is a contenteditable'], IDENTITY_A);

    ledger.begin(100, IDENTITY_B);
    ledger.flowSaved('other-flow', IDENTITY_B);
    ledger.memoryWritten(IDENTITY_B, 3);

    expect(ledger.take(200, IDENTITY_A)).toMatchObject({
      flows: {
        saved: ['invite'],
        replayed: [{ name: 'invite', verified: Verified.NO }],
      },
      memory: { written: 1, read: 1 },
    });
    expect(ledger.take(200, IDENTITY_B)).toMatchObject({
      flows: { saved: ['other-flow'], replayed: [] },
      memory: { written: 3, read: 0 },
    });
  });
  it('counts a failed replay as a flow, not as a journaled claim', () => {
    const ledger = new RunLedger();

    ledger.begin(0, IDENTITY_A);
    ledger.verdict(
      {
        ...verdict('the flow "invite" replays', Verified.UNKNOWN),
        tool: 'reticle_flow_replay',
      },
      IDENTITY_A,
    );
    ledger.replayed('invite', Verified.NO, IDENTITY_A);

    const report = ledger.take(10, IDENTITY_A);

    expect(report.verified).toBe(Verified.NO);
    expect(report.claims).toEqual([]);
    expect(report.flows.replayed).toEqual([{ name: 'invite', verified: Verified.NO }]);
    expect(report.caught).toContain('flow invite');
  });

  it('includes replay verdicts when calculating firstVerdictMs', () => {
    const ledger = new RunLedger();

    ledger.begin(100, IDENTITY_A);
    ledger.after(300, IDENTITY_A);
    ledger.replayed('invite', Verified.YES, IDENTITY_A);
    ledger.after(900, IDENTITY_A);

    const report = ledger.take(1000, IDENTITY_A);

    expect(report.firstVerdictMs).toBe(800);
  });

  it('ignores records written without an open run', () => {
    const ledger = new RunLedger();

    ledger.replayed('invite', Verified.NO, IDENTITY_A);
    ledger.verdict(verdict('some claim', Verified.YES), IDENTITY_A);

    ledger.begin(100, IDENTITY_A);

    const report = ledger.take(200, IDENTITY_A);

    expect(report.flows.replayed).toEqual([]);
    expect(report.claims).toEqual([]);
  });

  it('returns UNKNOWN when a run has no checked claims or replayed flows', () => {
    const ledger = new RunLedger();

    ledger.begin(100, IDENTITY_A);
    ledger.flowSaved('invite', IDENTITY_A);

    const report = ledger.take(200, IDENTITY_A);

    expect(report.verified).toBe(Verified.UNKNOWN);
  });
});
