import { describe, expect, it } from 'vitest';
import { toolCallOf } from './mcp.js';

/*
 * A Harness drive's wait outlived a 60s client timeout with nothing on the wire, so the client gave
 * up on a call that was working. A client that sends a progress token now hears every step.
 */
describe('what a tool call carries from the MCP request', () => {
  it('reports progress under the request token when the client asked for it', () => {
    const sent: unknown[] = [];
    const call = toolCallOf({
      _meta: { progressToken: 7 },
      sendNotification: (n) => {
        sent.push(n);
        return Promise.resolve();
      },
    });
    call.progress?.(3, 'step 3 · reticle_act');
    expect(sent).toEqual([
      {
        method: 'notifications/progress',
        params: { progressToken: 7, progress: 3, message: 'step 3 · reticle_act' },
      },
    ]);
  });

  it('reports nothing without a token, and still carries the cancellation', () => {
    const signal = new AbortController().signal;
    const call = toolCallOf({ signal, sendNotification: () => Promise.resolve() });
    expect(call.progress).toBeUndefined();
    expect(call.signal).toBe(signal);
  });
});
