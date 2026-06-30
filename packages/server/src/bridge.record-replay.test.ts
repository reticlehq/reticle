import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventType, ReticleCommand } from '@reticlehq/protocol';
import { Bridge } from './bridge.js';
import { TOOLS, type ToolDeps } from './tools/tools.js';
import { ReticleTool } from './tools/tool-names.js';
import { FakeBrowser, callTool, makeDeps, waitUntil } from './bridge.test-harness.js';

interface CompiledStep {
  tool: string;
  stable: boolean;
  args: Record<string, unknown>;
}
interface RecordStopResult {
  name: string;
  program: { version: number; steps: CompiledStep[] };
  warning?: string;
  summary: { network: number };
}
interface ReplayResult {
  name: string;
  ok: boolean;
  steps: { tool: string; ok: boolean; error?: string; note?: string }[];
}

describe('record -> compile -> replay', () => {
  let bridge: Bridge;
  let deps: ToolDeps;
  let browser: FakeBrowser;

  beforeAll(async () => {
    bridge = new Bridge({ port: 0 });
    const port = await bridge.ready;
    deps = makeDeps(bridge);
    browser = new FakeBrowser(port, 'demo');
    await browser.open();
    await waitUntil(() => bridge.sessions.count() === 1);
  });

  afterAll(async () => {
    browser.close();
    await bridge.close();
  });

  it('reticle_replay is registered with recordingName in its schema', () => {
    const tool = TOOLS.find((t) => t.name === ReticleTool.REPLAY);
    expect(tool).toBeDefined();
    expect(tool?.inputSchema['recordingName']).toBeDefined();
  });

  it('compiles a testid-bound program (stable) and keeps the reaction report', async () => {
    browser.actHasTestid = true;
    await callTool(deps, ReticleTool.RECORD_START, { recordingName: 'flow' });
    await callTool(deps, ReticleTool.ACT, { ref: 'e7', action: 'click' });
    browser.emit(EventType.NET_REQUEST, { method: 'POST', url: '/api/order', status: 200 });
    await waitUntil(() => bridge.sessions.resolve('demo').eventsSince(0).length >= 1);
    const rec = (await callTool(deps, ReticleTool.RECORD_STOP, {
      recordingName: 'flow',
    })) as RecordStopResult;
    expect(rec.program.version).toBe(1);
    expect(rec.program.steps).toHaveLength(1);
    expect(rec.program.steps[0]).toEqual({
      tool: 'reticle_act',
      stable: true,
      args: { by: 'testid', value: 'pay-btn', action: 'click', args: {} },
    });
    expect(rec.warning).toBeUndefined();
    expect(rec.summary.network).toBeGreaterThanOrEqual(1);
  });

  it('flags steps with no testid as unstable and warns', async () => {
    browser.actHasTestid = false;
    await callTool(deps, ReticleTool.RECORD_START, { name: 'noid' });
    await callTool(deps, ReticleTool.ACT, { ref: 'e7', action: 'click' });
    const rec = (await callTool(deps, ReticleTool.RECORD_STOP, {
      name: 'noid',
    })) as RecordStopResult;
    expect(rec.program.steps[0]?.stable).toBe(false);
    expect(rec.program.steps[0]?.args).toEqual({ ref: 'e7', action: 'click', args: {} });
    expect(rec.warning).toMatch(/not bound to a testid/);
    browser.actHasTestid = true;
  });

  it('replay re-resolves by testid and re-runs each step', async () => {
    await callTool(deps, ReticleTool.RECORD_START, { name: 'rerun' });
    await callTool(deps, ReticleTool.ACT, { ref: 'e7', action: 'click' });
    await callTool(deps, ReticleTool.RECORD_STOP, { name: 'rerun' });

    browser.received.length = 0;
    const replay = (await callTool(deps, ReticleTool.REPLAY, { name: 'rerun' })) as ReplayResult;
    expect(replay.ok).toBe(true);
    expect(replay.steps).toEqual([{ tool: 'reticle_act', ok: true }]);
    const query = browser.received.find((c) => c.name === ReticleCommand.QUERY);
    expect(query?.args).toMatchObject({ by: 'testid', value: 'pay-btn' });
    const act = browser.received.find((c) => c.name === ReticleCommand.ACT);
    expect(act?.args).toMatchObject({ ref: 'e7', action: 'click' });
  });

  it('replay of an unknown program throws', async () => {
    await expect(callTool(deps, ReticleTool.REPLAY, { recordingName: 'nope' })).rejects.toThrow(
      /no compiled recording named 'nope'/,
    );
  });

  it('replay stops with ok:false when a testid does not resolve', async () => {
    await callTool(deps, ReticleTool.RECORD_START, { recordingName: 'gone' });
    await callTool(deps, ReticleTool.ACT, { ref: 'e7', action: 'click' });
    await callTool(deps, ReticleTool.RECORD_STOP, { recordingName: 'gone' });

    browser.queryResolves = false;
    const replay = (await callTool(deps, ReticleTool.REPLAY, {
      recordingName: 'gone',
    })) as ReplayResult;
    expect(replay.ok).toBe(false);
    expect(replay.steps[0]?.ok).toBe(false);
    expect(replay.steps[0]?.error).toMatch(/did not resolve/);
    browser.queryResolves = true;
  });

  it('captures and replays an act_sequence step', async () => {
    await callTool(deps, ReticleTool.RECORD_START, { recordingName: 'seq' });
    await callTool(deps, ReticleTool.ACT_SEQUENCE, {
      steps: [{ ref: 'e7', action: 'click' }],
    });
    const rec = (await callTool(deps, ReticleTool.RECORD_STOP, {
      recordingName: 'seq',
    })) as RecordStopResult;
    expect(rec.program.steps[0]?.tool).toBe('reticle_act_sequence');
    expect(rec.program.steps[0]?.stable).toBe(true);

    browser.received.length = 0;
    const replay = (await callTool(deps, ReticleTool.REPLAY, {
      recordingName: 'seq',
    })) as ReplayResult;
    expect(replay.ok).toBe(true);
    expect(replay.steps[0]?.tool).toBe('reticle_act_sequence');
    const seqCmd = browser.received.find((c) => c.name === ReticleCommand.ACT_SEQUENCE);
    expect(seqCmd).toBeDefined();
  });
});
