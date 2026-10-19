/**
 * The end-of-run report, as the agent shows it to the user.
 *
 * A headless Claude Code run checked two journeys, saved two flows and caught a seat count the
 * server never got. It ended by releasing its tab and yielding, and no Reticle answer described the
 * run, so the agent wrote its own summary. These pin the report the run ends with instead.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLOUD_VALUE_LINE,
  RUN_REPORT_FIELD,
  RUN_REPORT_INSTRUCTION,
  ReticleDir,
  ReticleTool,
  RunReportSchema,
  UPGRADE_HINT_SILENCE_ENV,
  Verified,
  type RunReport,
} from '@reticlehq/core';
import { RunLedger } from '@/judgement/runs/run-ledger.js';
import { endsRun, noteToolResult, renderRunReport, runReportField } from './run-report.js';
import { runTool } from './invoke-tool.js';
import type { ToolDef, ToolDeps } from './tool-kit.js';
import type { SessionManager } from '@/portal/session/session-manager.js';

const REPORT: RunReport = {
  verified: Verified.NO,
  claims: [
    {
      claim: 'POST /api/members carries seats: 5',
      verified: Verified.NO,
      evidence: 'saw seats: 4',
    },
    { claim: 'the badge reads 5 seats', verified: Verified.YES, evidence: 'src/workspace.ts:230' },
    { claim: 'the task list settles', verified: Verified.UNKNOWN },
  ],
  caught: ['POST /api/members carries seats: 5', 'flow member-invite-seats'],
  flows: {
    saved: ['member-invite-seats', 'task-create'],
    replayed: [
      { name: 'member-invite-seats', verified: Verified.NO },
      { name: 'task-create', verified: Verified.YES },
    ],
  },
  memory: { written: 1, read: 0 },
  wallMs: 151_800,
  firstVerdictMs: 18_200,
  cloud: CLOUD_VALUE_LINE,
};

function project(linked: boolean): string {
  const root = join(mkdtempSync(join(tmpdir(), 'run-report-')), ReticleDir.ROOT);
  mkdirSync(root, { recursive: true });
  if (linked) writeFileSync(join(root, ReticleDir.CLOUD_LINK_FILE), '{}');
  return root;
}

describe('the end-of-run report', () => {
  it('renders every claim with its evidence, what it caught, flows, memory, time and the cloud line', () => {
    expect(renderRunReport(REPORT)).toMatchInlineSnapshot(`
      "**Reticle run report: failed** · 2 of 5 checks did not hold
      - no: POST /api/members carries seats: 5 (saw seats: 4)
      - yes: the badge reads 5 seats (src/workspace.ts:230)
      - unknown: the task list settles
      - Caught, expected to hold and did not: POST /api/members carries seats: 5; flow member-invite-seats
      - Flows saved: member-invite-seats, task-create
      - Flows replayed: member-invite-seats (no), task-create (yes)
      - Memory: 1 note written, 0 read
      - Time: 2m 32s, first verdict after 18.2s
      - Reticle Cloud (not linked): keeps this history across runs and agents, adds a team view and the hosted Harness. Plans and prices: https://app.reticle.sh"
    `);
  });

  it('says plainly when nothing was checked, and leaves out what was not measured', () => {
    const empty: RunReport = {
      verified: Verified.UNKNOWN,
      claims: [],
      caught: [],
      flows: { saved: [], replayed: [] },
      memory: { written: 0, read: 0 },
      wallMs: 4_000,
    };
    expect(renderRunReport(empty)).toMatchInlineSnapshot(`
      "**Reticle run report: not proved** · nothing was checked
      - Flows: none saved, none replayed
      - Memory: 0 notes written, 0 read
      - Time: 4.0s"
    `);
  });

  it('shows the cloud line only when the project is not linked, and never with the silence switch', () => {
    const take = (root: string, env: Record<string, string | undefined>): RunReport => {
      const ledger = new RunLedger();
      ledger.begin(0, 'attach-1');
      const field = runReportField(ledger, root, env, 10)[RUN_REPORT_FIELD];
      expect(field?.instruction).toBe(RUN_REPORT_INSTRUCTION);
      return RunReportSchema.parse(field?.report);
    };
    expect(take(project(false), {}).cloud).toBe(CLOUD_VALUE_LINE);
    expect(take(project(true), {}).cloud).toBeUndefined();
    expect(take(project(false), { [UPGRADE_HINT_SILENCE_ENV]: '1' }).cloud).toBeUndefined();
  });

  it('is offered once: an empty ledger adds no field', () => {
    const ledger = new RunLedger();
    expect(runReportField(ledger, project(false), {}, 0)).toEqual({});
  });

  it('ends a run on a session end, a yield, or a released tab, however the call was spelled', () => {
    expect(endsRun(ReticleTool.END_SESSION, {})).toBe(true);
    expect(endsRun(ReticleTool.YIELD, {})).toBe(true);
    expect(endsRun(ReticleTool.LEASE_RELEASE, {})).toBe(true);
    expect(endsRun(ReticleTool.SESSION, { action: 'end' })).toBe(true);
    expect(endsRun(ReticleTool.SESSION, { action: 'yield' })).toBe(true);
    expect(endsRun(ReticleTool.LEASE, { action: 'release' })).toBe(true);
    expect(endsRun(ReticleTool.SESSION, { action: 'tune' })).toBe(false);
    expect(endsRun(ReticleTool.LEASE, { action: 'acquire' })).toBe(false);
  });

  it('counts a saved flow and memory from the tool answers, never an answer that refused', () => {
    const ledger = new RunLedger();
    ledger.begin(0, 'attach-1');
    noteToolResult(ledger, ReticleTool.FLOW_SAVE, {}, { name: 'invite', stepCount: 1 });
    noteToolResult(ledger, ReticleTool.FLOW_SAVE, {}, { error: 'no recording named "x"' });
    noteToolResult(ledger, ReticleTool.MEMORY, { action: 'add' }, { error: 'not linked' });
    noteToolResult(ledger, ReticleTool.MEMORY, { action: 'add' }, { added: { id: 's1' } });
    noteToolResult(ledger, ReticleTool.MEMORY, {}, { known: [{ id: 's1' }, { id: 's2' }] });
    // The proof run wrote three notes to the intent ledger and its report said "0 notes written".
    noteToolResult(ledger, ReticleTool.INTENT, { action: 'record', id: 'seats' }, { recorded: 1 });
    noteToolResult(ledger, ReticleTool.INTENT, { action: 'record' }, { error: 'needs `id`' });
    noteToolResult(ledger, ReticleTool.INTENT, { action: 'subject', subject: 'x' }, { known: [] });
    const report = ledger.take(1);
    expect(report.flows.saved).toEqual(['invite']);
    expect(report.memory).toEqual({ written: 2, read: 3 });
  });
});

describe('the call that ends an agent run carries the report', () => {
  const fake = (name: string, answer: Record<string, unknown>): ToolDef => ({
    name,
    description: '',
    inputSchema: {},
    handler: () => Promise.resolve(answer),
  });
  const deps = (root: string, attachId?: string): ToolDeps =>
    ({
      sessions: { resolve: () => undefined } as unknown as SessionManager,
      reticleRoot: root,
      now: () => 0,
      ...(attachId === undefined ? {} : { attachId }),
    }) as unknown as ToolDeps;

  it('a released tab answers with the run: the flow it saved and the cloud line', async () => {
    const root = project(false);
    await runTool(fake(ReticleTool.FLOW_SAVE, { name: 'invite' }), deps(root, 'agent-1'), {});
    const released = (await runTool(
      fake(ReticleTool.LEASE, { released: true }),
      deps(root, 'agent-1'),
      { action: 'release' },
    )) as Record<string, unknown>;
    const field = released[RUN_REPORT_FIELD] as { report: RunReport; markdown: string };
    expect(field.report.flows.saved).toEqual(['invite']);
    expect(field.markdown).toContain(CLOUD_VALUE_LINE);
    // Taken once: the next end of a run with nothing in it carries no report.
    const again = (await runTool(fake(ReticleTool.YIELD, { yielded: true }), deps(root, 'a'), {
      mode: 'waiting',
    })) as Record<string, unknown>;
    expect(again[RUN_REPORT_FIELD]).toBeUndefined();
  });

  // The replay-session proof run released a tab that was already gone, so the session's project
  // could not be read, and the cloud line was left out of an unlinked project's report.
  it('reads the project of the session it ends before the end removes it', async () => {
    const root = project(false);
    let open = true;
    const tab = {
      ...deps(root, 'agent-2'),
      sessions: {
        resolve: () => {
          if (!open) throw new Error('no such session');
          return { id: 'lease-1', url: 'http://localhost:4336/' };
        },
      } as unknown as SessionManager,
    } as ToolDeps;
    const release: ToolDef = {
      name: ReticleTool.LEASE,
      description: '',
      inputSchema: {},
      handler: () => {
        open = false;
        return Promise.resolve({ released: true });
      },
    };
    await runTool(fake(ReticleTool.FLOW_SAVE, { name: 'invite' }), tab, {});
    const released = (await runTool(release, tab, {
      action: 'release',
      sessionId: 'lease-1',
    })) as Record<string, unknown>;
    const field = released[RUN_REPORT_FIELD] as { report: RunReport };
    expect(field.report.cloud).toBe(CLOUD_VALUE_LINE);
  });

  it('a call with no agent attached (the CLI, the Harness) starts no run', async () => {
    const root = project(false);
    await runTool(fake(ReticleTool.FLOW_SAVE, { name: 'invite' }), deps(root), {});
    const ended = (await runTool(fake(ReticleTool.END_SESSION, { ended: true }), deps(root), {
      claim: 'pass',
    })) as Record<string, unknown>;
    expect(ended[RUN_REPORT_FIELD]).toBeUndefined();
  });
});
