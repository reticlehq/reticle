/**
 * `init` ends with the first flow, driven in the tab the person is already looking at.
 *
 * Onboarding used to stop at "connected, nothing is verified yet", so the first saved flow — the
 * thing the dashboard's Flows page and every later replay are built on — depended on somebody
 * reading a numbered list and acting on it. With a linked project the Harness can drive that flow
 * itself; without one there is no model to drive with, and the one next step is said instead.
 */
import { describe, expect, it } from 'vitest';
import {
  FIRST_FLOW_PERSONA,
  FirstFlowSkip,
  firstFlowSkip,
  runFirstFlow,
  type FirstFlowPorts,
} from './try-command.js';

const CLOUD = { url: 'http://localhost:16510', apiKey: 'k' };
const SESSION = 's-1';
const URL = 'http://localhost:5173';

/** An explore answer as the MCP tool returns it: the report as structured content. */
const answer = (report: Record<string, unknown>): unknown => ({ structuredContent: report });

function ports(over: Partial<FirstFlowPorts> = {}): FirstFlowPorts & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    linked: () => Promise.resolve(CLOUD),
    grant: () => Promise.resolve({ granted: true, driveId: 'd-1' }),
    drive: () =>
      Promise.resolve(
        answer({
          status: 'done',
          savedFlows: ['first-visit'],
          rewroteFlows: [],
          checks: { held: 2, failed: 0 },
          goalMet: true,
        }),
      ),
    note: (line) => lines.push(line),
    ...over,
  };
}

describe('when init drives the first flow', () => {
  const base = { firstRun: true, json: false, openBrowser: true, headless: false, leased: false };

  it('drives by default, in a tab the person opened', () => {
    expect(firstFlowSkip(base)).toBeUndefined();
  });

  it('never drives as a surprise: --no-first-run, --json, --no-open, CI/headless, or a closed lease', () => {
    expect(firstFlowSkip({ ...base, firstRun: false })).toBe(FirstFlowSkip.FLAG);
    expect(firstFlowSkip({ ...base, json: true })).toBe(FirstFlowSkip.JSON);
    expect(firstFlowSkip({ ...base, openBrowser: false })).toBe(FirstFlowSkip.NO_OPEN);
    expect(firstFlowSkip({ ...base, headless: true })).toBe(FirstFlowSkip.HEADLESS);
    expect(firstFlowSkip({ ...base, leased: true })).toBe(FirstFlowSkip.LEASED);
  });
});

describe('the first flow', () => {
  it('drives the open tab as a first-time visitor, on the grant the platform gave', async () => {
    const asked: Record<string, unknown>[] = [];
    const p = ports({
      drive: (request) => {
        asked.push({ ...request });
        return ports().drive(request);
      },
    });
    await runFirstFlow(SESSION, URL, p);
    expect(asked).toEqual([
      expect.objectContaining({ sessionId: SESSION, driveId: 'd-1', persona: FIRST_FLOW_PERSONA }),
    ]);
  });

  it('reports the verdict and that the flow was saved', async () => {
    const p = ports();
    const out = await runFirstFlow(SESSION, URL, p);
    expect(out.flowSaved).toBe(true);
    const said = p.lines.join('\n');
    expect(said).toContain('1 work');
    expect(said).toContain('first-visit');
    expect(said).toMatch(/saved/i);
  });

  it('a drive that saved nothing is not a saved flow', async () => {
    const p = ports({
      drive: () => Promise.resolve(answer({ status: 'done', savedFlows: [], checks: {} })),
    });
    expect((await runFirstFlow(SESSION, URL, p)).flowSaved).toBe(false);
  });

  it('a refused drive says why and saves nothing', async () => {
    const p = ports({
      drive: () =>
        Promise.resolve({ isError: true, content: [{ type: 'text', text: 'switched off' }] }),
    });
    expect((await runFirstFlow(SESSION, URL, p)).flowSaved).toBe(false);
    expect(p.lines.join('\n')).toContain('switched off');
  });

  it('a refused grant says why and points at the plan, without driving', async () => {
    let drove = false;
    const p = ports({
      grant: () =>
        Promise.resolve({ granted: false, needsCard: true, message: 'No Harness runs left.' }),
      drive: () => {
        drove = true;
        return Promise.resolve(answer({}));
      },
    });
    expect((await runFirstFlow(SESSION, URL, p)).flowSaved).toBe(false);
    expect(drove).toBe(false);
    expect(p.lines.join('\n')).toContain('No Harness runs left.');
    expect(p.lines.join('\n')).toContain('/settings?group=billing');
  });

  it('with no linked project, says the one next step and never asks for a drive', async () => {
    let granted = false;
    const p = ports({
      linked: () => Promise.resolve(null),
      grant: () => {
        granted = true;
        return Promise.resolve({ granted: true, driveId: 'x' });
      },
    });
    expect((await runFirstFlow(SESSION, URL, p)).flowSaved).toBe(false);
    expect(granted).toBe(false);
    const said = p.lines.join('\n');
    expect(said).toContain('reticle connect');
    expect(said).toContain('reticle_act_and_wait');
    expect(said).toContain(URL);
  });

  it('a drive that throws is reported, not raised: init has already succeeded', async () => {
    const p = ports({ drive: () => Promise.reject(new Error('daemon went away')) });
    expect((await runFirstFlow(SESSION, URL, p)).flowSaved).toBe(false);
    expect(p.lines.join('\n')).toContain('daemon went away');
  });
});
