import { describe, expect, it } from 'vitest';
import { DriftReason, ReticleTool } from '@reticlehq/core';
import type { ToolCaller } from './adhoc-verdict.js';
import { daemonDriver } from './verify-against.js';
import { parseVerifySuffix } from './cli-parse-verify.js';

/** A daemon that answers each tool with a fixed payload, and records what it was asked. */
function fakeCaller(answers: Record<string, unknown>): {
  caller: ToolCaller;
  calls: { tool: string; args: Record<string, unknown> }[];
} {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const caller: ToolCaller = {
    call: (name, args) => {
      expect(name).toBe(ReticleTool.RUN);
      const tool = String(args['tool']);
      const inner = (args['args'] ?? {}) as Record<string, unknown>;
      calls.push({ tool, args: inner });
      return Promise.resolve({ structuredContent: answers[tool] });
    },
    close: () => Promise.resolve(),
  };
  return { caller, calls };
}

describe('daemonDriver', () => {
  it('reads the page through the snapshot tool, on the leased tab', async () => {
    const { caller, calls } = fakeCaller({
      [ReticleTool.SNAPSHOT]: { tree: '- button "Save" (ref=e1)', status: { route: '/x' } },
    });
    const driver = daemonDriver(caller, { url: 'http://a', sessionId: 's1', closeLease: false });
    expect(await driver.look()).toEqual({ tree: '- button "Save" (ref=e1)', route: '/x' });
    expect(await driver.read()).toBe('- button "Save" (ref=e1)');
    expect(calls.map((c) => c.args['sessionId'])).toEqual(['s1', 's1']);
    expect(calls.map((c) => c.args['mode'])).toEqual(['interactive', 'full']);
  });

  it('follows the session a navigation reports, and refuses an unconfirmed load', async () => {
    const ok = fakeCaller({
      [ReticleTool.NAVIGATE]: { ok: true, confirmed: true, sessionId: 's2' },
      [ReticleTool.SNAPSHOT]: { tree: '' },
    });
    const driver = daemonDriver(ok.caller, { url: 'http://a', sessionId: 's1', closeLease: false });
    expect(await driver.reset()).toBe(true);
    await driver.read();
    expect(ok.calls.at(-1)?.args['sessionId']).toBe('s2');
    const lost = fakeCaller({ [ReticleTool.NAVIGATE]: { ok: true, confirmed: false } });
    const other = daemonDriver(lost.caller, {
      url: 'http://a',
      sessionId: 's1',
      closeLease: false,
    });
    expect(await other.reset()).toBe(false);
  });

  it('counts an act as done only when it was dispatched', async () => {
    const yes = fakeCaller({ [ReticleTool.ACT]: { dispatched: true } });
    const no = fakeCaller({ [ReticleTool.ACT]: { dispatched: false } });
    const open = { url: 'http://a', sessionId: 's1', closeLease: false };
    expect((await daemonDriver(yes.caller, open).act('e1', 'fill', 'v')).ok).toBe(true);
    expect(yes.calls[0]?.args).toMatchObject({ ref: 'e1', action: 'fill', args: { value: 'v' } });
    expect((await daemonDriver(no.caller, open).act('e1', 'click')).ok).toBe(false);
  });

  it('replays one flow step at a time: the first from the start page, the rest where it is', async () => {
    const { caller, calls } = fakeCaller({
      [ReticleTool.FLOW_REPLAY]: { status: 'ok', steps: [{ step: 1, ok: true, anchor: 'save' }] },
    });
    const driver = daemonDriver(caller, { url: 'http://a', sessionId: 's1', closeLease: false });
    await driver.replayStep('checkout', 0);
    expect(await driver.replayStep('checkout', 1)).toEqual({ done: true, label: 'save' });
    expect(calls[0]?.args).toMatchObject({ flowName: 'checkout', to: 1 });
    expect(calls[0]?.args['at']).toBeUndefined();
    expect(calls[1]?.args).toMatchObject({ flowName: 'checkout', at: 1, to: 2 });
  });

  it('counts a step whose action ran and whose check failed as done, and a missed anchor as not', async () => {
    const checked = fakeCaller({
      [ReticleTool.FLOW_REPLAY]: {
        steps: [
          { step: 0, ok: false, anchor: 'pay', drift: { reasonKind: DriftReason.STATE_MISMATCH } },
        ],
      },
    });
    const missed = fakeCaller({
      [ReticleTool.FLOW_REPLAY]: {
        steps: [
          {
            step: 0,
            ok: false,
            anchor: 'pay',
            drift: { reasonKind: DriftReason.TESTID_NOT_FOUND },
          },
        ],
      },
    });
    const open = { url: 'http://a', sessionId: 's1', closeLease: false };
    expect((await daemonDriver(checked.caller, open).replayStep('f', 0)).done).toBe(true);
    expect((await daemonDriver(missed.caller, open).replayStep('f', 0)).done).toBe(false);
  });
});

describe('reticle verify --against', () => {
  it('reads the reference url, and keeps --select and --results-json', () => {
    const parsed = parseVerifySuffix(
      [
        'http://pr.test',
        '--against',
        'http://prod.test',
        '--select',
        'cart',
        '--results-json',
        'o.json',
      ],
      4400,
    );
    expect(parsed).toMatchObject({
      kind: 'ok',
      url: 'http://pr.test',
      against: 'http://prod.test',
      select: ['cart'],
      resultsJson: 'o.json',
    });
    expect(parseVerifySuffix(['http://pr.test'], 4400)).not.toHaveProperty('against');
  });

  it('needs a url, and refuses a predicate or a model drive beside it', () => {
    expect(parseVerifySuffix(['http://pr.test', '--against'], 4400)).toMatchObject({
      kind: 'error',
    });
    for (const extra of [['--expect', '{"kind":"signal","name":"x"}'], ['--explore']]) {
      expect(
        parseVerifySuffix(['http://pr.test', '--against', 'http://prod.test', ...extra], 4400),
      ).toMatchObject({ kind: 'error' });
    }
  });
});
