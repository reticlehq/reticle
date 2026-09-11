import { describe, it, expect } from 'vitest';
import { selectPath, capDepth } from './state-select.js';
import { TOOLS } from '../tools/tools.js';
import { ReticleTool } from '../tools/tool-names.js';
import { SessionState, type CommandResult } from '@reticlehq/core';
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
    // `length` is listed alongside the indices because it is genuinely selectable on an array.
    expect(r.availableKeys).toEqual(['0', '1', 'length']);
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

  /**
   * The ENVELOPE is unchanged — `{ stores, storeNames }`, same keys, same store names, nothing
   * reshaped into `{ found, value }`. That is what callers depend on and what this pinned.
   *
   * The values inside are now bounded by default, because an unscoped read returned the whole tree
   * and a tool result is re-sent on every later turn: 10,119 bytes measured on the bench fixture,
   * about 34,000 tokens across a 16-turn run for one call. `captionCache.v3.text` sits below that
   * bound here, so it collapses and the reply says so — a smaller read that did not admit it was
   * smaller is the false green this whole file guards against.
   */
  it('keeps the envelope, bounds the values, and discloses the bound', async () => {
    const res = (await stateTool().handler(fakeDeps(result), { store: 'workspace' })) as {
      stores: Record<string, unknown>;
      storeNames: string[];
      truncation?: { note?: string };
    };
    expect(Object.keys(res).sort()).toEqual(['storeNames', 'stores', 'truncation']);
    expect(res.storeNames).toEqual(['workspace']);
    expect(res.stores['workspace'], 'the store is still there and still named').toBeDefined();
    expect(res.truncation?.note, 'the bound is admitted').toMatch(/not the whole store/i);
  });

  it('says nothing about truncation when the store fits inside the bound', async () => {
    const shallow = { stores: { workspace: { version: 7 } }, storeNames: ['workspace'] };
    const res = (await stateTool().handler(fakeDeps(shallow), {})) as { truncation?: unknown };
    expect(res.truncation).toBeUndefined();
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
