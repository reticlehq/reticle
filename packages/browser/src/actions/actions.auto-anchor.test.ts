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
        if (null === name || name === undefined) return null;
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

  /**
   * ANCHOR and SOURCE answer different questions, and collapsing them cost us the more valuable one.
   *
   *   anchor — how do I find this element again on the next run?   (testid wins; stays lean)
   *   source — where in the codebase is this element defined?       (always worth carrying)
   *
   * The original rule was "a testid wins, so skip the component walk", which silently made source
   * conditional on the element NOT having a testid. The perverse result: an app that followed
   * Reticle's own advice and added data-testid everywhere got fewer source pointers than an
   * uninstrumented one. Since locating the right file is the most valuable thing we can hand an
   * agent, the anchor's leanness is not worth paying for with it.
   */
  it('carries source even when a testid is present', async () => {
    registerAdapter({
      name: 'aa-fake',
      identify: (el: Element): ComponentInfo | null => {
        const owner = el.closest('[data-component]');
        const name = owner?.getAttribute('data-component');
        if (null === name || name === undefined) return null;
        return { componentStack: [name], source: { file: 'src/Topbar.tsx', line: 31 } };
      },
    });
    document.body.innerHTML =
      '<div data-component="Topbar" data-src="src/Topbar.tsx:31">' +
      '<button data-testid="new-deploy">Open panel</button></div>';
    const btn = document.querySelector('button') as HTMLButtonElement;
    const res = await executeAction(refs.refFor(btn), 'click', {});

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.testid).toBe('new-deploy');
    expect(res.source).toEqual({ file: 'src/Topbar.tsx', line: 31 });
    expect(res.component).toBe('Topbar');
  });

  it('still reports the testid as the anchor when no source is discoverable', async () => {
    registerAdapter({ name: 'aa-fake', identify: (): ComponentInfo | null => null });
    document.body.innerHTML = '<button data-testid="new-deploy">Open panel</button>';
    const btn = document.querySelector('button') as HTMLButtonElement;
    const res = await executeAction(refs.refFor(btn), 'click', {});

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.testid).toBe('new-deploy');
    expect(res.source).toBeUndefined();
  });
});

/**
 * An element with a role but NO accessible name reported neither.
 *
 * `anchorOf` set `role` and `name` together or not at all. An icon button, a clickable div, a
 * control whose label is an SVG — all have a role and no name, and once `identifyComponent`
 * (React-specific) also returns nothing, the act reply carried NO identity whatsoever.
 *
 * Two features read that identity and both quietly degrade without it: the flow recorder anchors a
 * step by it, and `reticle_coverage` recognises a control it already drove across a re-render by it.
 * Reported from a sweep as `exercised: 0` after four successful acts, on the non-React stacks.
 *
 * A role alone is not a unique anchor and nothing here pretends it is — the flow compiler still
 * requires role AND name before it will anchor a step that way. But it is real information, and
 * reporting it is strictly better than reporting nothing.
 */
describe('anchor identity when there is no accessible name', () => {
  it('reports the role even when the name is empty', async () => {
    document.body.innerHTML = '<button id="icon"><svg></svg></button>';
    const el = document.querySelector('#icon');
    if (null === el) throw new Error('fixture missing');
    const ref = refs.refFor(el);
    const out = await executeAction(ref, 'click', {});
    expect(out.role).toBe('button');
    expect(out.name).toBeUndefined();
  });

  it('still reports both when both exist', async () => {
    document.body.innerHTML = '<button id="named">Details</button>';
    const el = document.querySelector('#named');
    if (null === el) throw new Error('fixture missing');
    const out = await executeAction(refs.refFor(el), 'click', {});
    expect(out.role).toBe('button');
    expect(out.name).toBe('Details');
  });
});
