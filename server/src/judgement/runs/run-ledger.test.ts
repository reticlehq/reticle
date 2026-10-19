/**
 * The run ledger: what one agent run checked, saved and read, kept until the run's report is taken.
 *
 * Found by a headless Claude Code run on a fixture: it checked two journeys, saved two flows, caught
 * a seat count the server never got, and ended by releasing its tab. Reticle answered nothing about
 * the run as a whole, so the agent wrote its own summary.
 */
import { describe, expect, it } from 'vitest';
import { JOURNAL_FILE_VERSION, Verified, type JournalAction } from '@reticlehq/core';
import { RunLedger } from './run-ledger.js';

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

const AGENT = 'attach-1';

describe('the run ledger', () => {
  it('starts a new run when another agent calls, so one run does not leak into the next report', () => {
    const ledger = new RunLedger();
    // The first agent checks something and stops without a call that ends its run.
    ledger.begin(0, AGENT);
    ledger.verdict(verdict('the old claim', Verified.NO));
    ledger.after(10);
    // The next agent on the same daemon.
    ledger.begin(5_000, 'attach-2');
    ledger.verdict(verdict('the new claim', Verified.YES));
    ledger.after(5_200);
    const report = ledger.take(6_000);
    expect(report.claims.map((c) => c.claim)).toEqual(['the new claim']);
    expect(report.verified).toBe(Verified.YES);
    expect(report.wallMs).toBe(1_000);
    expect(report.firstVerdictMs).toBe(200);
  });

  it('is empty until an agent call, and takes a report only once', () => {
    const ledger = new RunLedger();
    expect(ledger.isEmpty()).toBe(true);
    ledger.begin(1_000, AGENT);
    ledger.verdict(verdict('task shows', Verified.YES));
    ledger.after(1_500);
    expect(ledger.isEmpty()).toBe(false);
    const report = ledger.take(4_000);
    expect(report.wallMs).toBe(3_000);
    expect(report.firstVerdictMs).toBe(500);
    expect(ledger.isEmpty()).toBe(true);
  });

  it('lists every claim with one piece of evidence, and the failed ones as caught', () => {
    const ledger = new RunLedger();
    ledger.begin(0, AGENT);
    ledger.verdict(
      verdict('the request carries seats: 5', Verified.NO, {
        observed: 'POST /api/members sent seats: 4',
        source: 'src/workspace.ts:220',
      }),
    );
    ledger.verdict(verdict('5 seats shows', Verified.YES, { source: 'src/workspace.ts:230' }));
    ledger.verdict(verdict('the list settles', Verified.UNKNOWN));
    const report = ledger.take(10);
    expect(report.verified).toBe(Verified.NO);
    expect(report.claims).toEqual([
      {
        claim: 'the request carries seats: 5',
        verified: Verified.NO,
        evidence: 'saw POST /api/members sent seats: 4',
      },
      { claim: '5 seats shows', verified: Verified.YES, evidence: 'src/workspace.ts:230' },
      { claim: 'the list settles', verified: Verified.UNKNOWN },
    ]);
    expect(report.caught).toEqual(['the request carries seats: 5']);
  });

  it('does not count a passive no that a later yes of the same claim superseded', () => {
    const ledger = new RunLedger();
    ledger.begin(0, AGENT);
    ledger.verdict(verdict('saved', Verified.NO, { declaredBeforeActing: false }));
    ledger.verdict(verdict('saved', Verified.YES));
    const report = ledger.take(10);
    expect(report.claims.map((c) => c.verified)).toEqual([Verified.YES]);
    expect(report.verified).toBe(Verified.YES);
  });

  it('keeps flows saved and replayed, and memory written and read', () => {
    const ledger = new RunLedger();
    ledger.begin(0, AGENT);
    ledger.flowSaved('invite');
    ledger.flowSaved('invite');
    ledger.replayed('invite', Verified.NO);
    ledger.replayed('task-create', Verified.YES);
    ledger.memoryWritten();
    ledger.memoryRead(['the composer is a contenteditable']);
    ledger.memoryRead(['the composer is a contenteditable']);
    const report = ledger.take(10);
    expect(report.flows).toEqual({
      saved: ['invite'],
      replayed: [
        { name: 'invite', verified: Verified.NO },
        { name: 'task-create', verified: Verified.YES },
      ],
    });
    expect(report.memory).toEqual({ written: 1, read: 1 });
    // A replay that did not hold is a failed run, and is caught, even with no claim journaled.
    expect(report.verified).toBe(Verified.NO);
    expect(report.caught).toEqual(['flow invite']);
  });

  // The replay-session proof run: a replay that failed was journaled `unknown`, its run said `no`,
  // and the report read "failed · 0 of 5 checks did not hold". A replay is counted once, as a flow.
  it('counts a replay as a flow, never also as a journaled claim', () => {
    const ledger = new RunLedger();
    ledger.begin(0, AGENT);
    ledger.verdict({
      ...verdict('the flow "invite" replays', Verified.UNKNOWN),
      tool: 'reticle_flow_replay',
    });
    ledger.replayed('invite', Verified.NO);
    const report = ledger.take(10);
    expect(report.claims).toEqual([]);
    expect(report.flows.replayed).toEqual([{ name: 'invite', verified: Verified.NO }]);
  });

  // The replay proof run's report had no time to its first verdict: its only verdicts were replays.
  it('times the first verdict from a replay too', () => {
    const ledger = new RunLedger();
    ledger.begin(100, AGENT);
    ledger.after(300);
    ledger.replayed('invite', Verified.NO);
    ledger.after(900);
    expect(ledger.take(1_000).firstVerdictMs).toBe(800);
  });

  it('keeps nothing while no agent run is open', () => {
    const ledger = new RunLedger();
    ledger.replayed('invite', Verified.NO);
    ledger.verdict(verdict('saved', Verified.YES));
    ledger.begin(0, AGENT);
    const report = ledger.take(10);
    expect(report.flows.replayed).toEqual([]);
    expect(report.claims).toEqual([]);
  });

  it('says nothing was proved when nothing was checked', () => {
    const ledger = new RunLedger();
    ledger.begin(0, AGENT);
    ledger.flowSaved('invite');
    const report = ledger.take(10);
    expect(report.verified).toBe(Verified.UNKNOWN);
    expect(report.firstVerdictMs).toBeUndefined();
  });
});
