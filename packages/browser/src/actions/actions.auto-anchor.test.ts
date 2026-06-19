import { describe, it, expect, beforeEach } from 'vitest';
import { executeAction } from './actions.js';
import { refs } from '../dom/refs.js';
import { registerAdapter, type ComponentInfo } from '../registry/adapters.js';

/**
 * Auto-anchor capture at act time: when an acted element has NO data-testid, the result carries the
 * element's component name + source (from the framework adapter) so the server compiles a STABLE
 * component anchor instead of a degraded ref. A testid still wins (lean — no component noise).
 */
beforeEach(() => {
  document.body.innerHTML = '';
});

describe('act result — auto-anchor fallback (component/source when no testid)', () => {
  it('attaches component + source for an element with no testid', async () => {
    // Fake adapter: read component identity from data-component / data-src attributes.
    registerAdapter({
      name: 'aa-fake',
      identify: (el: Element): ComponentInfo | null => {
        const owner = el.closest('[data-component]');
        const name = owner?.getAttribute('data-component');
        if (name === null || name === undefined) return null;
        const src = owner?.getAttribute('data-src');
        const info: ComponentInfo = { componentStack: [name] };
        if (src !== null && src !== undefined) {
          const [file, line] = src.split(':');
          if (file !== undefined && line !== undefined) {
            info.source = { file, line: Number(line) };
          }
        }
        return info;
      },
    });
    document.body.innerHTML =
      '<div data-component="NewDeployButton" data-src="src/Deployments.tsx:107"><button>Open panel</button></div>';
    const btn = document.querySelector('button') as HTMLButtonElement;
    const res = await executeAction(refs.refFor(btn), 'click', {});

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.testid).toBeUndefined();
    expect(res.component).toBe('NewDeployButton');
    expect(res.source).toEqual({ file: 'src/Deployments.tsx', line: 107 });
  });

  it('a testid still wins — no component noise on the result', async () => {
    registerAdapter({
      name: 'aa-fake',
      identify: (): ComponentInfo | null => ({ componentStack: ['Whatever'] }),
    });
    document.body.innerHTML = '<button data-testid="new-deploy">Open panel</button>';
    const btn = document.querySelector('button') as HTMLButtonElement;
    const res = await executeAction(refs.refFor(btn), 'click', {});

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.testid).toBe('new-deploy');
    expect(res.component).toBeUndefined();
  });
});
