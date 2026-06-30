import { describe, it, expect } from 'vitest';
import {
  EventType,
  ReticleCommand,
  SessionState,
  type CommandResult,
  type ReticleEvent,
} from '@reticle/protocol';
import { TOOLS, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import type { Session, SessionManager } from '../session/session.js';

/** A session whose MATCH answers `matched`, and whose buffer is a fixed event list. */
function depsWith(opts: { matched?: boolean; events?: ReticleEvent[] }): ToolDeps {
  const matchResult = {
    matched: opts.matched ?? false,
    count: opts.matched === true ? 1 : 0,
    elements:
      opts.matched === true
        ? [{ ref: 'e1', role: 'button', name: 'X', states: [], visible: true }]
        : [],
  };
  const stub: Partial<Session> = {
    id: 'demo',
    command: (name: string): Promise<CommandResult> =>
      Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result: name === ReticleCommand.MATCH ? matchResult : {},
      }),
    eventsSince: () => opts.events ?? [],
    lastActCursor: () => 0,
    health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
  };
  const sessions: Partial<SessionManager> = { resolve: () => stub as Session };
  return { sessions: sessions as SessionManager } as ToolDeps;
}

function assertTool() {
  const t = TOOLS.find((x) => x.name === ReticleTool.ASSERT);
  if (t === undefined) throw new Error('no reticle_assert tool');
  return t;
}

const signal = (name: string): ReticleEvent => ({
  t: 1,
  type: EventType.SIGNAL,
  sessionId: 's',
  data: { name, data: {} },
});

describe('reticle_assert presence-only advice', () => {
  it('attaches advice to a PASSING presence-only (element) assertion', async () => {
    const r = (await assertTool().handler(depsWith({ matched: true }), {
      predicate: { kind: 'element', query: { role: 'button' } },
    })) as { pass: boolean; advice?: string };
    expect(r.pass).toBe(true);
    expect(r.advice).toContain('consequence');
  });

  it('does NOT attach advice to a signal consequence assertion', async () => {
    const r = (await assertTool().handler(depsWith({ events: [signal('order:placed')] }), {
      predicate: { kind: 'signal', name: 'order:placed' },
    })) as { pass: boolean; advice?: string };
    expect(r.pass).toBe(true);
    expect(r.advice).toBeUndefined();
  });

  it('does NOT attach advice to a FAILING presence assertion (moot)', async () => {
    const r = (await assertTool().handler(depsWith({ matched: false }), {
      predicate: { kind: 'element', query: { role: 'button' } },
    })) as { pass: boolean; advice?: string };
    expect(r.pass).toBe(false);
    expect(r.advice).toBeUndefined();
  });
});
