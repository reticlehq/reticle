/**
 * A flow step that opens a page in the middle of a journey.
 *
 * The outcome of a change often shows only on another page: pause a link on the dashboard, then the
 * short link must stop redirecting. A flow had no way to open that page, so no flow could check the
 * outcome. Graded with such flows, a change that built the button and the label and left the
 * redirect untouched passed every check. A `navigate` step opens the page, the replay goes on with
 * the page that loads, and the step's `expect` is judged there.
 */
import { describe, expect, it } from 'vitest';
import {
  AnchorKind,
  FLOW_FILE_VERSION,
  FlowStepTool,
  PredicateKind,
  ReticleCommand,
  type CommandResult,
  type FlowFile,
} from '@reticlehq/core';
import { replayFlow, type FlowReplaySession, type WaitForSignal } from './flow-replay.js';
import { navigateAndAwait } from './flow-start-path.js';
import { SESSION_DISCONNECTED_REASON } from '@/portal/session/facts/session-replaced.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { Session } from '@/portal/session/session.js';

/** A page that shows one text. */
function page(text: string): FlowReplaySession {
  return {
    command(name: string): Promise<CommandResult> {
      const result = ReticleCommand.QUERY === name ? { elements: [] } : { dispatched: true };
      return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
    },
    eventsSince: () => [],
    onEvent: () => () => undefined,
    elapsed: () => 0,
    url: `http://localhost:3000/${text}`,
  };
}

/** Passes a text expect when the page it is asked about shows that text. */
const waitForSignal: WaitForSignal = (session, predicate) =>
  Promise.resolve({
    pass:
      PredicateKind.SETTLED === predicate.kind ||
      (PredicateKind.TEXT === predicate.kind &&
        (session.url ?? '').endsWith(predicate.contains ?? '')),
  });

const flow: FlowFile = {
  version: FLOW_FILE_VERSION,
  name: 'paused-link-is-refused',
  createdAt: 0,
  steps: [
    {
      tool: FlowStepTool.NAVIGATE,
      anchor: { kind: AnchorKind.TESTID, value: '/u07' },
      navigate: '/u07',
      expect: { kind: PredicateKind.TEXT, contains: 'not-found' },
    },
  ],
};

describe('a navigate step', () => {
  it('opens the page and judges the expect on the page that loaded', async () => {
    const opened: string[] = [];
    const results = await replayFlow(page('start'), flow, waitForSignal, 60, false, undefined, {
      navigate: (url) => {
        opened.push(url);
        return Promise.resolve({ session: page('not-found') });
      },
    });
    expect(opened).toEqual(['/u07']);
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.drift).toBeUndefined();
  });

  it('fails when the page that loaded does not show the outcome', async () => {
    const results = await replayFlow(page('start'), flow, waitForSignal, 60, false, undefined, {
      navigate: () => Promise.resolve({ session: page('target-site') }),
    });
    expect(results[0]?.ok).toBe(false);
  });

  it('fails, and says why, when no page of the app loaded', async () => {
    const results = await replayFlow(page('start'), flow, waitForSignal, 60, false, undefined, {
      navigate: () => Promise.resolve({ error: 'no page of this app answered after opening /u07' }),
    });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toContain('/u07');
  });

  it('fails rather than skips when this replay cannot open pages', async () => {
    const results = await replayFlow(page('start'), flow, waitForSignal, 60);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toBeDefined();
  });
});

/*
 * A navigate step opens `/u07`, and the server answers with a redirect to `/404`. The page that
 * connects is the destination: a server redirect lands once. The start-page arrival waits out its
 * whole budget before it accepts another path, which cost every such step 5 s for nothing.
 */
describe('navigateAndAwait for a navigate step', () => {
  it('accepts the first new page at once, on whatever path the server sent it to', async () => {
    const dying = {
      id: 'old',
      url: 'http://localhost:3000/',
      command: () => Promise.reject(new Error(SESSION_DISCONNECTED_REASON)),
    };
    const landed = { id: 'new', url: 'http://localhost:3000/404', eventsSince: () => [] };
    const sessions = { resolve: () => landed as unknown as Session } as unknown as SessionManager;
    let t = 0;
    const clock = {
      now: () => t,
      sleep: () => {
        t += 100;
        return Promise.resolve();
      },
    };
    const outcome = await navigateAndAwait(sessions, dying, '/u07', '/u07', 5_000, clock, {
      acceptRedirect: true,
    });
    expect(outcome.kind).toBe('redirected');
    expect(t).toBeLessThan(5_000);
  });
});
