/**
 * A flow step that sends one request to the app and judges the answer.
 *
 * Some rules live only on the server: a bad sort value is refused with 400, an undo after its window
 * is refused, a signed-out caller is refused. A page that behaves can hide a server that does not,
 * and a flow could only drive the page, so a change that left those rules out passed every check.
 * A `request` step sends the request as the signed-in page would (its cookies), or as a signed-out
 * caller, and judges the status and the body.
 */
import { describe, expect, it } from 'vitest';
import {
  AnchorKind,
  FLOW_FILE_VERSION,
  FlowStepTool,
  ReticleCommand,
  type CommandResult,
  type FlowFile,
  type FlowStep,
} from '@reticlehq/core';
import { replayFlow, type FlowReplaySession, type WaitForSignal } from './flow-replay.js';

const page: FlowReplaySession = {
  command(name: string): Promise<CommandResult> {
    const result = ReticleCommand.QUERY === name ? { elements: [] } : { dispatched: true };
    return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
  },
  eventsSince: () => [],
  onEvent: () => () => undefined,
  elapsed: () => 0,
};

const waitForSignal: WaitForSignal = () => Promise.resolve({ pass: true });

const step = (response: NonNullable<FlowStep['response']>): FlowStep => ({
  tool: FlowStepTool.REQUEST,
  anchor: { kind: AnchorKind.TESTID, value: 'GET /api/links?sort=bogus' },
  request: { method: 'GET', url: '/api/links?sort=bogus' },
  response,
});

const flow = (s: FlowStep): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name: 'bad-sort-is-refused',
  createdAt: 0,
  steps: [s],
});

describe('a request step', () => {
  it('passes when the status and the body are as declared', async () => {
    const sent: unknown[] = [];
    const results = await replayFlow(
      page,
      flow(step({ status: 400, contains: 'sort' })),
      waitForSignal,
      60,
      false,
      undefined,
      {
        request: (req) => {
          sent.push(req);
          return Promise.resolve({ status: 400, body: '{"error":"Invalid sort."}' });
        },
      },
    );
    expect(sent).toEqual([{ method: 'GET', url: '/api/links?sort=bogus' }]);
    expect(results[0]?.ok).toBe(true);
  });

  it('fails on another status, and names both', async () => {
    const results = await replayFlow(
      page,
      flow(step({ status: 400 })),
      waitForSignal,
      60,
      false,
      undefined,
      { request: () => Promise.resolve({ status: 200, body: '[]' }) },
    );
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toContain('200');
    expect(results[0]?.error).toContain('400');
  });

  it('fails when the body holds a text it must not', async () => {
    const results = await replayFlow(
      page,
      flow(step({ absent: 'u01' })),
      waitForSignal,
      60,
      false,
      undefined,
      { request: () => Promise.resolve({ status: 200, body: '[{"address":"u01"}]' }) },
    );
    expect(results[0]?.ok).toBe(false);
  });

  it('fails rather than skips when this replay cannot send requests', async () => {
    const results = await replayFlow(page, flow(step({ status: 400 })), waitForSignal, 60);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toBeDefined();
  });
});

/*
 * A request that changes data goes behind the same guard as a destructive click. A saved flow with
 * `DELETE /api/links/...` replayed against any app the flow is pointed at, with the signed-in user's
 * cookies, and nothing asked first. Flow files are shared, so the run must say yes, not the file.
 */
describe('a request step that changes data', () => {
  const del: FlowStep = {
    tool: FlowStepTool.REQUEST,
    anchor: { kind: AnchorKind.TESTID, value: 'DELETE /api/links/1' },
    request: { method: 'DELETE', url: '/api/links/1' },
    response: { status: 200 },
  };

  it('is refused, and sends nothing, unless the run confirms dangerous steps', async () => {
    const sent: unknown[] = [];
    const results = await replayFlow(page, flow(del), waitForSignal, 60, false, undefined, {
      request: (req) => {
        sent.push(req);
        return Promise.resolve({ status: 200, body: '' });
      },
    });
    expect(sent).toHaveLength(0);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toContain('confirmDangerous');
  });

  it('is sent when the run confirms dangerous steps', async () => {
    const sent: unknown[] = [];
    const results = await replayFlow(page, flow(del), waitForSignal, 60, true, undefined, {
      request: (req) => {
        sent.push(req);
        return Promise.resolve({ status: 200, body: '' });
      },
    });
    expect(sent).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
  });

  it('lets a read through without confirmation', async () => {
    const results = await replayFlow(
      page,
      flow(step({ status: 400 })),
      waitForSignal,
      60,
      false,
      undefined,
      {
        request: () => Promise.resolve({ status: 400, body: '' }),
      },
    );
    expect(results[0]?.ok).toBe(true);
  });
});
