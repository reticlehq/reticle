import { describe, it, expect } from 'vitest';
import { ReticleCommand } from '@reticlehq/core';
import { READ_TOOLS } from './read-tools.js';
import { ReticleTool } from './tool-names.js';
import type { ToolDeps } from './tools.js';
import type { Session, SessionManager } from '../session/session.js';

function stateDeps(result: unknown): ToolDeps {
  const session = {
    command: (name: string) =>
      Promise.resolve({
        kind: 'command_result',
        id: 'x',
        ok: true,
        result: name === ReticleCommand.STATE_READ ? result : {},
      }),
  } as unknown as Session;
  const sessions = { resolve: () => session } as unknown as SessionManager;
  return { sessions } as unknown as ToolDeps;
}

function stateTool() {
  const t = READ_TOOLS.find((x) => x.name === ReticleTool.STATE);
  if (t === undefined) throw new Error('no reticle_state tool');
  return t;
}

/** One React effect entry as the fiber walk sanitizes it: everything actionable is already null. */
const EFFECT = {
  tag: 9,
  create: null,
  deps: ['', [{ id: 'line-0', qty: 1 }], false],
  inst: { destroy: null },
  next: { tag: 9, create: null, deps: [4249], inst: { destroy: null }, next: null },
};

const BROWSER_RESULT = {
  stores: {},
  storeNames: [],
  component: {
    ok: true,
    component: 'Cart',
    hooks: [[{ id: 'line-0', qty: 1 }], '', false, { current: '[Node]' }, EFFECT, EFFECT],
  },
};

describe('reticle_state component projection', () => {
  it('strips React effect chains from the hook list the agent is billed for', async () => {
    const r = (await stateTool().handler(stateDeps(BROWSER_RESULT), { ref: 'e9' })) as {
      component?: { component?: string; hooks?: unknown[] };
    };
    expect(r.component?.component).toBe('Cart');
    expect(r.component?.hooks).toEqual([
      [{ id: 'line-0', qty: 1 }],
      '',
      false,
      { current: '[Node]' },
    ]);
    expect(JSON.stringify(r.component?.hooks).length).toBeLessThan(
      JSON.stringify(BROWSER_RESULT.component.hooks).length / 2,
    );
  });

  it('discloses the drop instead of trimming silently', async () => {
    const r = (await stateTool().handler(stateDeps(BROWSER_RESULT), { ref: 'e9' })) as {
      component?: { truncation?: { droppedItems: number; note: string } };
    };
    expect(r.component?.truncation?.droppedItems).toBe(2);
    expect(r.component?.truncation?.note).toContain('effect');
  });
});
