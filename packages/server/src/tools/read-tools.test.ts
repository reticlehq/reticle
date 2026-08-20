import { describe, expect, it } from 'vitest';
import type { CommandResult } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from './tools.js';
import { ReticleTool } from './tool-names.js';
import type { Session, SessionManager } from '../session/session.js';

/**
 * An unscoped state read must not hand back the entire store tree — and must not change shape to
 * achieve that.
 *
 * A tool result is not paid once. It stays in the conversation and is re-sent on every later turn,
 * so a reply costs its own size multiplied by the turns that follow it. Measured on this repo's own
 * fixture, one unscoped `reticle_state` returned 10,119 bytes — about 2,530 tokens, and roughly
 * 34,000 across the rest of a 16-turn run, for one call. Bounded, the same read is 795 bytes and
 * still names every store, with collections collapsed to markers like "[Array(40)]".
 *
 * The first attempt at this bounded the read by routing it through the path selector, which changed
 * the reply from `{ stores, storeNames, component }` to `{ found, value }`. Four tests caught it:
 * the component projection, its truncation disclosure, the documented "unchanged when no path/depth"
 * contract, and the bridge round-trip. Capability, not cost, and the tests were right.
 *
 * So the VALUES are bounded and the ENVELOPE is untouched. Nothing became unreachable: an explicit
 * `depth` is honoured at any value and `path` reads a sub-tree at full fidelity.
 */
function runState(
  args: Record<string, unknown>,
  result: unknown,
): { forwarded: Record<string, unknown>; reply: Promise<unknown> } {
  const forwarded: Record<string, unknown> = {};
  const session = {
    command: (_name: string, payload: Record<string, unknown>): Promise<CommandResult> => {
      Object.assign(forwarded, payload);
      return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result });
    },
  } as unknown as Session;
  const deps = {
    sessions: { resolve: () => session } as unknown as SessionManager,
  } as unknown as ToolDeps;
  const tool = TOOLS.find((t) => t.name === ReticleTool.STATE);
  if (tool === undefined) throw new Error('reticle_state missing');
  return { forwarded, reply: Promise.resolve(tool.handler(deps, args)) };
}

/** A store whose depth is the whole problem: a long collection several levels down. */
const DEEP = {
  stores: { app: { view: 'overview', deployments: [{ id: 1, meta: { tags: ['a', 'b'] } }] } },
  storeNames: ['app'],
};

describe('reticle_state is bounded by default', () => {
  it('keeps the documented envelope — the shape callers depend on', async () => {
    const { reply } = runState({}, DEEP);
    const out = (await reply) as Record<string, unknown>;
    expect(Object.keys(out), 'no { found, value } switcheroo').toContain('stores');
    expect(out['storeNames']).toEqual(['app']);
    expect(out).not.toHaveProperty('found');
  });

  it('bounds the values inside those stores', async () => {
    const { reply } = runState({}, DEEP);
    const out = (await reply) as { stores: Record<string, unknown> };
    expect(JSON.stringify(out.stores), 'the deep collection is collapsed').not.toContain('"tags"');
    expect(JSON.stringify(out.stores), 'but the store is still named and readable').toContain(
      'overview',
    );
  });

  it('forwards an explicit depth untouched, at any value', async () => {
    const { forwarded } = runState({ depth: 9 }, DEEP);
    await Promise.resolve();
    expect(forwarded['depth']).toBe(9);
  });

  it('forwards a path untouched, so a drilled read keeps full fidelity', async () => {
    const { forwarded } = runState({ store: 'app', path: 'deployments.0' }, DEEP);
    await Promise.resolve();
    expect(forwarded['path']).toBe('deployments.0');
    expect(
      forwarded['depth'],
      'a named path is already scoped; do not bound it too',
    ).toBeUndefined();
  });
});

/**
 * A bounded read has to SAY it is bounded.
 *
 * Without that, an agent sees `deployments: "[Array(40)]"`, takes it for the store's contents, and
 * asserts over a summary it never asked for — a green reached from evidence that was silently
 * withheld, which is the failure this product exists to prevent. The marker alone is suggestive;
 * the disclosure makes it explicit and names the way to the real value.
 *
 * Only when something was actually trimmed: a note on every reply is noise, and noise is how a real
 * disclosure stops being read.
 */
describe('the bound is disclosed', () => {
  it('says so, and says how to get the full value', async () => {
    const { reply } = runState({}, DEEP);
    const out = (await reply) as { truncation?: { note?: string } };
    expect(out.truncation?.note, 'a silently smaller read is a false green').toBeDefined();
    expect(out.truncation?.note).toMatch(/not the whole store/i);
    expect(out.truncation?.note, 'names the way out').toMatch(/path|depth/);
  });

  it('stays quiet when nothing was trimmed', async () => {
    const { reply } = runState({}, { stores: { app: { view: 'overview' } }, storeNames: ['app'] });
    const out = (await reply) as { truncation?: unknown };
    expect(out.truncation).toBeUndefined();
  });
});
