import { describe, it, expect } from 'vitest';
import { createCommandRegistry } from './commands.js';
import { executeAction } from '../actions/actions.js';
import { refs } from '../dom/refs.js';

const reg = createCommandRegistry();

describe('upload action', () => {
  it('rejects a non-file target with a clear error', async () => {
    document.body.innerHTML = '<input type="text" />';
    const el = document.querySelector('input') as HTMLInputElement;
    await expect(executeAction(refs.refFor(el), 'upload', { name: 'x.txt' })).rejects.toThrow(
      /file/,
    );
  });
});

describe('inspect computed styles (for hover/visual checks)', () => {
  it('returns color + backgroundColor for a ref', () => {
    document.body.innerHTML = '<button style="background: rgb(1, 2, 3)">Hi</button>';
    const el = document.querySelector('button') as HTMLButtonElement;
    const handler = reg.get('inspect');
    if (handler === undefined) throw new Error('no inspect handler');
    const info = handler({ ref: refs.refFor(el) }) as {
      styles: { backgroundColor: string } | null;
    };
    expect(info.styles).not.toBeNull();
    expect(info.styles?.backgroundColor).toContain('rgb');
  });
});
