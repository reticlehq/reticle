import { describe, expect, it } from 'vitest';
import {
  FLOW_FILE_VERSION,
  ReplayStatus,
  type FlowFile,
  type FlowReplayResult,
} from '@reticlehq/core';
import { ReticleTool } from '../tools/tool-names.js';
import { buildFlowReport } from './flow-report.js';

function flow(partial: Partial<FlowFile> = {}): FlowFile {
  return { version: FLOW_FILE_VERSION, name: 'verify-500', createdAt: 0, steps: [], ...partial };
}

const passReplay: FlowReplayResult = {
  name: 'verify-500',
  status: ReplayStatus.OK,
  steps: [
    {
      step: 0,
      tool: ReticleTool.ACT,
      anchor: 'login-submit',
      page: '/',
      ok: true,
      consequence: 'signal auth:granted; POST /api/login 200',
    },
    {
      step: 1,
      tool: ReticleTool.ACT,
      anchor: 'fault-500',
      page: '/diagnostics',
      ok: true,
      consequence: 'signal fault:injected; GET /api/broken/500 500',
    },
  ],
};

describe('buildFlowReport — human confidence artifact', () => {
  it('renders intent (verified), verdict, a mermaid diagram, journey table, and evidence', () => {
    const md = buildFlowReport({
      flow: flow({
        intent: 'inject a 500 fault and observe it',
        success: { signal: 'fault:injected' },
      }),
      replay: passReplay,
      replayTokens: 213,
      competitorTokens: 30249,
    });
    expect(md).toContain('# Flow report — `verify-500`');
    expect(md).toContain('inject a 500 fault and observe it');
    expect(md).toContain('verified');
    expect(md).toContain('✅ pass');
    expect(md).toContain('```mermaid');
    expect(md).toContain('flowchart TD');
    expect(md).toContain('/diagnostics');
    expect(md).toContain('142×'); // 30249 / 213, rendered bold then "cheaper than an LLM re-drive"
    expect(md).toContain('cheaper than an LLM re-drive');
    expect(md).toContain('signal fault:injected'); // evidence
  });

  it('flags an intent that is declared but not asserted', () => {
    const md = buildFlowReport({ flow: flow({ intent: 'do a thing' }), replay: passReplay });
    expect(md).toContain('declared but NOT asserted');
  });

  it('surfaces the decision (next action + where) on a drift', () => {
    const driftReplay: FlowReplayResult = {
      name: 'verify-500',
      status: ReplayStatus.DRIFT,
      steps: [
        {
          step: 0,
          tool: ReticleTool.ACT,
          anchor: 'fault-500',
          page: '/diagnostics',
          ok: false,
          drift: {
            reasonKind: 'testid_not_found',
            reason: 'testid "fault-500" not found',
            anchor: 'fault-500',
            nearest: 'fault-404',
          },
        },
      ],
      decision: {
        verdict: 'drift',
        summary: 'drifted',
        whatChanged: 'testid "fault-500" not found',
        whereInSource: 'src/Diagnostics.tsx:16',
        suggestedFix: 'rebind to "fault-404"',
        nextAction: 'rebind the anchor to "fault-404", or update the flow if intended.',
      },
    };
    const md = buildFlowReport({ flow: flow(), replay: driftReplay });
    expect(md).toContain('⚠️ drift');
    expect(md).toContain('Next action:');
    expect(md).toContain('fault-404');
    expect(md).toContain('src/Diagnostics.tsx:16');
    expect(md).toContain('drift (fault-500)'); // journey table result column
  });
});
