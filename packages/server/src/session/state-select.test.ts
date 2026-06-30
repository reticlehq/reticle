import { describe, it, expect } from 'vitest';
import { selectPath, capDepth } from './state-select.js';
import { TOOLS } from '../tools/tools.js';
import { ReticleTool } from '../tools/tool-names.js';
import { SessionState, type CommandResult } from '@reticle/protocol';
import type { Session, SessionManager } from './session.js';
import type { ToolDeps } from '../tools/tools.js';

describe('selectPath', () => {
  const root = { captionCache: { v3: [{ text: 'hi' }, { text: 'yo' }] }, count: 2 };

  it('returns root for an empty path', () => {
    expect(selectPath(root, '').value).toBe(root);
  });

  it('walks object keys and array indices', () => {
    expect(selectPath(root, 'captionCache.v3.1.text')).toEqual({ found: true, value: 'yo' });
  });

  it('reports a near-miss with available keys on a wrong key', () => {
    const r = selectPath(root, 'captionCache.v9');
    expect(r.found).toBe(false);
    expect(r.availableKeys).toEqual(['v3']);
  });

  it('reports a near-miss for an out-of-range array index', () => {
    const r = selectPath(root, 'captionCache.v3.5');
    expect(r.found).toBe(false);
    expect(r.availableKeys).toEqual(['0', '1']);
  });
});

describe('capDepth', () => {
  it('collapses nested objects past the budget to a size marker', () => {
    const v = { a: { b: { c: 1 } } };
    // depth N retains N levels: depth 1 keeps top keys, collapses one level down.
    expect(capDepth(v, 1)).toEqual({ a: '{…1 keys}' });
    expect(capDepth(v, 2)).toEqual({ a: { b: '{…1 keys}' } });
  });

  it('collapses arrays past the budget', () => {
    expect(capDepth({ rows: [1, 2, 3] }, 0)).toBe('{…1 keys}');
    expect(capDepth({ rows: [1, 2, 3] }, 1)).toEqual({ rows: '[Array(3)]' });
  });

  it('no cap for a negative budget', () => {
    const v = { a: { b: 1 } };
    expect(capDepth(v, -1)).toBe(v);
  });
});

// ── reticle_state wiring ──────────────────────────────────────────────────────────
function fakeDeps(stateResult: unknown): ToolDeps {
  const stub: Partial<Session> = {
    id: 'demo',
    command: (): Promise<CommandResult> =>
      Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: stateResult }),
    getState: () => SessionState.ACTIVE,
    drainInbox: () => [],
  };
  const sessions: Partial<SessionManager> = { resolve: () => stub as Session };
  return { sessions: sessions as SessionManager } as ToolDeps;
}

function stateTool() {
  const tool = TOOLS.find((t) => t.name === ReticleTool.STATE);
  if (tool === undefined) throw new Error('no reticle_state tool');
  return tool;
}

describe('reticle_state path selector', () => {
  const result = {
    stores: { workspace: { captionCache: { v3: { text: 'hi' } }, version: 7 } },
    storeNames: ['workspace'],
  };

  it('returns the full result unchanged when no path/depth is given', async () => {
    const res = await stateTool().handler(fakeDeps(result), { store: 'workspace' });
    expect(res).toEqual(result);
  });

  it('extracts a sub-tree by path relative to the named store', async () => {
    const res = (await stateTool().handler(fakeDeps(result), {
      store: 'workspace',
      path: 'captionCache.v3',
    })) as { value: unknown; found: boolean };
    expect(res.found).toBe(true);
    expect(res.value).toEqual({ text: 'hi' });
  });

  it('surfaces a near-miss with available keys for a wrong path', async () => {
    const res = (await stateTool().handler(fakeDeps(result), {
      store: 'workspace',
      path: 'nope',
    })) as { found: boolean; availableKeys?: string[] };
    expect(res.found).toBe(false);
    expect(res.availableKeys).toEqual(['captionCache', 'version']);
  });
});
