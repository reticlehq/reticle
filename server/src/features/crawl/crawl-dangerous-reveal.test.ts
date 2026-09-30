/**
 * `confirmDangerous` authorizes the destructive controls the caller could see, not the ones a
 * destructive click reveals.
 *
 * A crawl follows what its own clicks put on the page. With the authorization handed to every click,
 * a "Delete" that opens "Are you sure? — Delete" had its confirmation clicked in the next round with
 * the same flag, so one call finished a deletion nobody looked at the second half of.
 */

import { describe, expect, it } from 'vitest';
import {
  DANGEROUS_ACTION_CONFIRM_ARG,
  ReticleCommand,
  type CommandResult,
  type ReticleEvent,
} from '@reticlehq/core';
import { crawl } from './crawl.js';

const noSleep = (): Promise<void> => Promise.resolve();

describe('confirmDangerous does not carry over to what a click revealed', () => {
  it('sends the authorization with the first page’s clicks only', async () => {
    const clicks: { ref: string; confirmed: boolean }[] = [];
    let opened = false;
    const ok = (result: unknown): Promise<CommandResult> =>
      Promise.resolve({ kind: 'command_result', id: 'x', ok: true, result });
    const session = {
      elapsed: () => 0,
      eventsSince: (): ReticleEvent[] => [
        { type: 'dom.added', t: 1, data: {} } as unknown as ReticleEvent,
      ],
      command: (name: string, args?: Record<string, unknown>): Promise<CommandResult> => {
        if (name === ReticleCommand.SNAPSHOT) {
          const tree = opened
            ? '- button "Delete account" (ref=e1)\n- button "Yes, delete" (ref=e2)'
            : '- button "Delete account" (ref=e1)';
          return ok({ tree });
        }
        const ref = String(args?.['ref']);
        const extra = (args?.['args'] ?? {}) as Record<string, unknown>;
        clicks.push({ ref, confirmed: true === extra[DANGEROUS_ACTION_CONFIRM_ARG] });
        if ('e1' === ref) opened = true;
        return ok({ ok: true, dispatched: true });
      },
    };
    await crawl(session, { maxSteps: 10, confirmDangerous: true }, noSleep);
    expect(clicks).toContainEqual({ ref: 'e1', confirmed: true });
    expect(clicks.filter((c) => 'e2' === c.ref)).toEqual([{ ref: 'e2', confirmed: false }]);
  });
});
