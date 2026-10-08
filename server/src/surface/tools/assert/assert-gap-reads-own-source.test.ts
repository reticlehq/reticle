/**
 * `no-source-mapping` on an assertion means "nothing in this verdict could be located" (#1422).
 *
 * The gap rule was fed only `session.lastAct.source()`. With no act yet, a failing
 * `{ role, name }` assertion whose role-only near misses all carried `source` still listed
 * `no-source-mapping` and advised installing the build plugin. The plugin was working; the
 * locator was wrong. Agents went and reinstalled it.
 */

import { describe, expect, it } from 'vitest';
import { type CommandResult, type ReticleEvent } from '@reticlehq/core';
import { ReticleTool } from '@reticlehq/core';
import { LastAct } from '@/portal/session/last-act.js';
import { TOOLS, type ToolDef, type ToolDeps } from '@/surface/tools/tools.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { createFakeSession } from '@/portal/session/fake-session.js';
import { stampedSourceIn } from './assert-source.js';

const NO_SOURCE_MAPPING = 'no-source-mapping';

const tool = (name: string): ToolDef => {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`${name} is not on the surface`);
  return found;
};

const button = (name: string, source?: string): Record<string, unknown> => ({
  ref: 'e1',
  tag: 'button',
  role: 'button',
  name,
  states: [],
  visible: true,
  ...(source === undefined ? {} : { source }),
});

/**
 * A page whose exact `{ role, name }` query matches nothing, and whose role-only query (the near
 * miss) matches `nearMiss`. No act has run, so the session remembers no source of its own.
 */
function depsFor(nearMiss: readonly Record<string, unknown>[]): ToolDeps {
  const noEvents: ReticleEvent[] = [];
  const command = (...args: unknown[]): Promise<CommandResult> => {
    const exact = JSON.stringify(args).includes('Wrong name');
    const elements = exact ? [] : nearMiss;
    return Promise.resolve({
      kind: 'command_result',
      id: 'c',
      ok: true,
      result: { matched: elements.length > 0, count: elements.length, elements },
    });
  };
  const session = createFakeSession(
    {
      lastAct: new LastAct(),
      command,
      recordAction: () => 'a1',
      bufferHealth: () => ({ total: 5, dropped: 0 }),
      eventsSince: () => noEvents,
      queryEvents: () => Promise.resolve(noEvents),
      elapsed: () => 1000,
      health: () => ({ lastSeenMs: 5, throttled: false, focused: true }),
    },
    { url: 'http://localhost:3000/' },
  );
  const sessions: Partial<SessionManager> = { resolve: () => session };
  return {
    sessions: sessions as SessionManager,
    recordings: new RecordingStore(),
  } as unknown as ToolDeps;
}

const wrongName = {
  predicate: { kind: 'element', query: { role: 'button', name: 'Wrong name' } },
  timeout_ms: 0,
};

async function gapKinds(nearMiss: readonly Record<string, unknown>[]): Promise<string[]> {
  const result = (await tool(ReticleTool.ASSERT).handler(depsFor(nearMiss), wrongName)) as {
    pass?: boolean;
    instrumentationGaps?: { kind?: string }[];
  };
  expect(result.pass).toBe(false);
  return (result.instrumentationGaps ?? []).map((g) => String(g.kind));
}

describe('a failing assert reads its own evidence before claiming no source mapping', () => {
  it('lists no no-source-mapping gap when its near miss carries a source', async () => {
    const kinds = await gapKinds([button('Save', 'src/Toolbar.tsx:12')]);

    expect(kinds).not.toContain(NO_SOURCE_MAPPING);
  });

  it('still lists it when nothing in the verdict carries a source', async () => {
    const kinds = await gapKinds([button('Save')]);

    expect(kinds).toContain(NO_SOURCE_MAPPING);
  });
});

describe('stampedSourceIn', () => {
  it('finds a stamp inside a near miss', () => {
    expect(stampedSourceIn({ nearMiss: [button('Save'), button('Undo', 'a.tsx:3')] })).toBe(
      'a.tsx:3',
    );
  });

  it('finds nothing in evidence without a stamp, or with an empty one', () => {
    expect(stampedSourceIn({ nearMiss: [button('Save'), button('Undo', '')] })).toBeUndefined();
    expect(stampedSourceIn(undefined)).toBeUndefined();
    expect(stampedSourceIn('src/a.tsx:1')).toBeUndefined();
  });

  it('finds a stamp under nested combinator evidence', () => {
    const nested = {
      members: [{ members: [{ evidence: { nearMiss: [button('Save', 'a.tsx:3')] } }] }],
    };
    expect(stampedSourceIn(nested)).toBe('a.tsx:3');
  });

  it("does not read a console error's script URL as a build stamp", () => {
    const consoleError = {
      type: 'console.error',
      message: 'boom',
      source: 'http://localhost:3000/main.js',
    };
    expect(stampedSourceIn([consoleError])).toBeUndefined();
    expect(stampedSourceIn({ matched: [consoleError] })).toBeUndefined();
  });

  it('stops at a bounded depth', () => {
    let deep: unknown = button('Save', 'deep.tsx:1');
    for (let i = 0; i < 40; i += 1) deep = { next: deep };
    expect(stampedSourceIn(deep)).toBeUndefined();
  });
});
