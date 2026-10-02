/**
 * `reticle_look { action: "element" }` without a ref blamed the ref it never had.
 *
 * `reticle_inspect` declares `ref` as a REQUIRED string, so on its own it cannot be called without
 * one. Merging it into `reticle_look` makes every action's parameters optional — they have to be,
 * since `page`, `find`, `state` and `element` want different ones — so the requirement was lost at
 * exactly the point an agent meets it.
 *
 * MEASURED while driving bench-app. `reticle_look { action: "element", testid: "awkward-icon" }` is
 * the obvious call: `testid` is a declared parameter of `reticle_look`, the sibling `find` action
 * takes it, and nothing says `element` will not. It answered:
 *
 *     ref '' no longer resolves to an element
 *     That ref is stale: refs are invalidated whenever the DOM re-renders …
 *
 * Every word of which is wrong here. Nothing was stale, nothing re-rendered, and there was no ref —
 * so the advice sends a reader to re-snapshot a page that was never the problem. The empty string
 * was carried all the way to the browser and described as a ref that had expired.
 */
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '@reticlehq/core';
import { MERGED_TOOLS, TOOLS, type ToolDeps } from './tools.js';
import { ReticleTool } from '@reticlehq/core';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';

function deps(seen: { cmd?: string }): ToolDeps {
  const command = (cmd: string): Promise<CommandResult> => {
    seen.cmd = cmd;
    return Promise.resolve({ kind: 'command_result', id: 'c', ok: true, result: {} });
  };
  const session: Partial<Session> = { id: 'demo', command };
  const sessions: Partial<SessionManager> = { resolve: () => session as Session };
  return { sessions: sessions as SessionManager } as unknown as ToolDeps;
}

const inspect = () => {
  const tool = TOOLS.find((t) => t.name === ReticleTool.INSPECT);
  if (tool === undefined) throw new Error('reticle_inspect is not on the surface');
  return tool;
};

describe('inspecting an element without naming one', () => {
  it('refuses instead of sending an empty ref to the browser', async () => {
    const seen: { cmd?: string } = {};
    await expect(inspect().handler(deps(seen), {})).rejects.toThrow();
    expect(seen.cmd, 'the call reached the browser anyway').toBeUndefined();
  });

  /*
   * The refusal has to name the missing thing, not blame a ref that was never supplied. "That ref is
   * stale" sends a reader to re-snapshot a page that is fine.
   */
  it('says a ref is required, and where to get one', async () => {
    const error = await inspect()
      .handler(deps({}), {})
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(error).toContain('ref');
    expect(error).not.toContain('stale');
    expect(error).toContain(ReticleTool.QUERY);
  });

  // The specific call that produced the bad message: a LOCATOR was given, just not a ref. Saying so
  // is the difference between "you named nothing" and "you named it the way the other action wants".
  it('recognises that a locator was given where a ref was wanted', async () => {
    const error = await inspect()
      .handler(deps({}), { testid: 'awkward-icon' })
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(error).toContain('testid');
  });

  it('still inspects normally when a ref is given', async () => {
    const seen: { cmd?: string } = {};
    await inspect().handler(deps(seen), { ref: 'e42' });
    expect(seen.cmd).toBe('inspect');
  });

  /*
   * The call as it was actually made. `reticle_inspect` is not what an agent types on the merged
   * surface — it types `reticle_look { action: "element" }`, and that is the only place the lost
   * requirement is reachable, so the guard is worth nothing if it does not hold through the merge.
   */
  it('holds through the merged reticle_look', async () => {
    const seen: { cmd?: string } = {};
    const look = MERGED_TOOLS.find((t) => t.name === ReticleTool.LOOK);
    if (look === undefined) throw new Error('reticle_look is not on the merged surface');
    const error = await look
      .handler(deps(seen), { action: 'element', testid: 'awkward-icon' })
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(error).toContain('testid');
    expect(error).not.toContain('stale');
    expect(seen.cmd, 'the call reached the browser anyway').toBeUndefined();
  });
});
