import { describe, it, expect, vi } from 'vitest';
import { IrisCommand, type MatchResult } from '@iris/protocol';
import { createCommandRegistry } from './commands.js';
import { refs } from './refs.js';

const reg = createCommandRegistry();

function run(name: string, args: Record<string, unknown> = {}): unknown {
  const handler = reg.get(name);
  if (handler === undefined) throw new Error(`no handler ${name}`);
  return handler(args);
}

describe('command registry (driven by the bridge)', () => {
  it('SNAPSHOT returns a tree with status', () => {
    document.body.innerHTML = '<button>Save</button>';
    const result = run(IrisCommand.SNAPSHOT, {}) as { tree: string; status: { route: string } };
    expect(result.tree).toContain('button "Save"');
    expect(result.status.route).toBeDefined();
  });

  it('MATCH finds an element and reports state', () => {
    document.body.innerHTML = '<button disabled>Go</button>';
    const result = run(IrisCommand.MATCH, {
      query: { role: 'button', name: 'Go' },
      state: 'disabled',
    }) as MatchResult;
    expect(result.matched).toBe(true);
  });

  it('ACT clicks the element referenced by a prior snapshot', () => {
    document.body.innerHTML = '<button>Click</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const onClick = vi.fn();
    button.addEventListener('click', onClick);
    const ref = refs.refFor(button);
    run(IrisCommand.ACT, { ref, action: 'click' });
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('INSPECT returns descriptor + box for a ref', () => {
    document.body.innerHTML = '<a href="/x">Home</a>';
    const link = document.querySelector('a') as HTMLAnchorElement;
    const ref = refs.refFor(link);
    const result = run(IrisCommand.INSPECT, { ref }) as { role: string; tag: string };
    expect(result.role).toBe('link');
    expect(result.tag).toBe('a');
  });
});
