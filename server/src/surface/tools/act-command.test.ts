/**
 * The `type`/`value` spelling mix-up: `reticle_act` documents `{ text }` for type and `{ value }`
 * for fill/select, and agents write the wrong one (reticlehq/reticle#2126, second item). The
 * normalization maps a string `value` onto `text` for the `type` action, in the flat args and in
 * the nested `args` object, and leaves every other action untouched.
 */

import { describe, expect, it } from 'vitest';

import { ActionType, asRecord, type CommandResult, ReticleCommand } from '@reticlehq/core';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { ArtifactRootReason } from '@/memory/project/artifact-root.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';

import { actCommand } from './act-command.js';
import { normalizeTypeSpelling } from './type-spelling.js';
import type { ToolDeps } from './tools.js';

describe('normalizeTypeSpelling', () => {
  it('maps a flat string value to text for the type action', () => {
    const out = normalizeTypeSpelling({ ref: 'r1', action: 'type', value: 'hello' });
    expect(out).toEqual({ ref: 'r1', action: 'type', text: 'hello' });
  });

  it('maps a value nested inside args for the type action', () => {
    const out = normalizeTypeSpelling({
      ref: 'r1',
      action: 'type',
      args: { value: 'hello' },
    });
    expect(out).toEqual({ ref: 'r1', action: 'type', args: { text: 'hello' } });
  });

  it('keeps a non-string value alone so the browser refusal stays accurate', () => {
    const out = normalizeTypeSpelling({ ref: 'r1', action: 'type', value: 42 });
    expect(out).toEqual({ ref: 'r1', action: 'type', value: 42 });
  });

  it('keeps value when text is already set', () => {
    const out = normalizeTypeSpelling({
      ref: 'r1',
      action: 'type',
      text: 'explicit',
      value: 'fallback',
    });
    expect(out).toEqual({ ref: 'r1', action: 'type', text: 'explicit', value: 'fallback' });
  });

  it('leaves other actions untouched', () => {
    const step = { ref: 'r1', action: 'fill', value: 'hello' };
    expect(normalizeTypeSpelling(step)).toEqual(step);
  });
});

/**
 * Dispatch-level pin: whatever the map decides must be what the browser receives. A non-string
 * `value` reaches `session.command` exactly as the agent wrote it, so the browser's own refusal
 * keeps its accurate message (#2126).
 */
describe('actCommand type/value dispatch', () => {
  function harness(): {
    deps: ToolDeps;
    session: Session;
    sent: () => Record<string, unknown>;
  } {
    let sentArgs: Record<string, unknown> = {};
    const session: Partial<Session> = {
      id: 'dispatch-pin',
      url: 'http://localhost:15999/',
      command: (_cmd, args): Promise<CommandResult> => {
        sentArgs = asRecord(args);
        return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
      },
    };
    const sessions: Partial<SessionManager> = { resolve: () => session as Session };
    const deps = {
      fs: createNodeFileSystem(),
      reticleRoot: '/tmp/reticle-dispatch-pin/.reticle',
      sessions: sessions as SessionManager,
      artifactRootFor: () => ({
        root: '/tmp/reticle-dispatch-pin/.reticle',
        reason: ArtifactRootReason.MATCHED_PROJECT,
      }),
    } as unknown as ToolDeps;
    return { deps, session: session as Session, sent: () => sentArgs };
  }

  it('sends a non-string flat value to the browser unchanged', async () => {
    const { deps, session, sent } = harness();
    await actCommand(deps, session, ReticleCommand.ACT, {
      ref: 'r1',
      action: ActionType.TYPE,
      value: 42,
    });
    expect(sent()['value']).toBe(42);
    expect(sent()['text']).toBeUndefined();
  });

  it('sends a non-string nested value to the browser unchanged', async () => {
    const { deps, session, sent } = harness();
    await actCommand(deps, session, ReticleCommand.ACT, {
      ref: 'r1',
      action: ActionType.TYPE,
      args: { value: 42 },
    });
    expect(asRecord(sent()['args'])['value']).toBe(42);
    expect(asRecord(sent()['args'])['text']).toBeUndefined();
  });

  it('maps a string value onto text at the dispatch point', async () => {
    const { deps, session, sent } = harness();
    await actCommand(deps, session, ReticleCommand.ACT, {
      ref: 'r1',
      action: ActionType.TYPE,
      value: 'hello',
    });
    expect(sent()['text']).toBe('hello');
    expect(sent()['value']).toBeUndefined();
  });
});
