/**
 * A control with no accessible name gives the destructive-action guard no text to classify.
 *
 * A per-row trash icon is `<button><svg/></button>`: no label, no `title`, no `aria-label`. The crawl
 * used to click it, so an app with no confirm step lost the row. The crawl now leaves it alone and
 * says so in `notJudged`. `confirmDangerous` lets the caller include it.
 */

import { describe, expect, it } from 'vitest';
import { type CommandResult, type ReticleEvent, ReticleCommand } from '@reticlehq/core';
import { crawl } from './crawl.js';

const noSleep = (): Promise<void> => Promise.resolve();
const TREE = '- button "Save" (ref=e1)\n- button (ref=e2)';

function makeSession(clicks: string[]): Parameters<typeof crawl>[0] {
  const ok = (result: unknown): Promise<CommandResult> =>
    Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result });
  return {
    elapsed: () => 0,
    eventsSince: (): ReticleEvent[] => [
      { type: 'dom.added', t: 1, data: {} } as unknown as ReticleEvent,
    ],
    command: (name: string, args?: Record<string, unknown>): Promise<CommandResult> => {
      if (name === ReticleCommand.SNAPSHOT) {
        return ok({ tree: TREE });
      }
      clicks.push(String(args?.['ref']));
      return ok({ ok: true, dispatched: true });
    },
  };
}

describe('crawl and a control with no accessible name', () => {
  it('does not click it and reports it as not judged', async () => {
    const clicks: string[] = [];
    const report = await crawl(makeSession(clicks), { maxSteps: 10 }, noSleep);
    expect(clicks).toEqual(['e1']);
    expect(report.notJudged?.map((n) => n.ref)).toEqual(['e2']);
    expect(report.notJudged?.[0]?.reason).toContain('no accessible name');
  });

  it('clicks it when the caller sets confirmDangerous', async () => {
    const clicks: string[] = [];
    await crawl(makeSession(clicks), { maxSteps: 10, confirmDangerous: true }, noSleep);
    expect(clicks).toEqual(['e1', 'e2']);
  });
});
