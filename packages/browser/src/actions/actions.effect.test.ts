import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ActionWarning, ReticleCommand } from '@reticlehq/core';
import { executeAction, executeSequence } from './actions.js';
import { createCommandRegistry } from '../commands/commands.js';
import { registerAdapter, type ReticleAdapter } from '../registry/adapters.js';
import { refs } from '../dom/refs.js';

const adapters = ((
  globalThis as unknown as { __reticleAdapters?: ReticleAdapter[] }
).__reticleAdapters ??= []);

function refOf(selector: string): string {
  const el = document.querySelector(selector);
  if (null === el) throw new Error(`no element for ${selector}`);
  return refs.refFor(el);
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('action effect: happy path', () => {
  it('reports dispatched/targetMatched/visible/enabled on a normal click', async () => {
    document.body.innerHTML = '<button>Save</button>';
    const r = await executeAction(refOf('button'), 'click');
    expect(r.effect.dispatched).toBe(true);
    expect(r.effect.targetMatched).toBe(true);
    expect(r.effect.visible).toBe(true);
    expect(r.effect.enabled).toBe(true);
  });
});

describe('action effect: enabled / visible probes', () => {
  it('enabled=false for a disabled button', async () => {
    document.body.innerHTML = '<button disabled>Save</button>';
    const r = await executeAction(refOf('button'), 'click');
    expect(r.effect.enabled).toBe(false);
  });

  it('visible=false for a display:none button', async () => {
    document.body.innerHTML = '<button style="display:none">Save</button>';
    const r = await executeAction(refOf('button'), 'click');
    expect(r.effect.visible).toBe(false);
  });
});

describe('action effect: defaultPrevented', () => {
  it('defaultPrevented=true when a handler calls preventDefault', async () => {
    document.body.innerHTML = '<a href="#">link</a>';
    const a = document.querySelector('a') as HTMLAnchorElement;
    a.addEventListener('click', (e) => {
      e.preventDefault();
    });
    const r = await executeAction(refs.refFor(a), 'click');
    expect(r.effect.defaultPrevented).toBe(true);
  });

  it('defaultPrevented=false when nothing prevents', async () => {
    document.body.innerHTML = '<button>Save</button>';
    const r = await executeAction(refOf('button'), 'click');
    expect(r.effect.defaultPrevented).toBe(false);
  });
});

describe('action effect: focusMoved', () => {
  it('reports null->eN when focusing an input', async () => {
    document.body.innerHTML = '<input />';
    const r = await executeAction(refOf('input'), 'focus');
    expect(r.effect.focusMoved).toMatch(/^null->e\d+$/);
  });

  it('reports ->null on blur', async () => {
    document.body.innerHTML = '<input />';
    const input = document.querySelector('input') as HTMLInputElement;
    input.focus();
    const r = await executeAction(refs.refFor(input), 'blur');
    expect(r.effect.focusMoved).toMatch(/->null$/);
  });

  it('focusMoved=null when clicking a non-focusing div', async () => {
    document.body.innerHTML = '<div>plain</div>';
    const r = await executeAction(refOf('div'), 'click');
    expect(r.effect.focusMoved).toBeNull();
  });
});

describe('action effect: valueChanged', () => {
  it('valueChanged=true on fill', async () => {
    document.body.innerHTML = '<input />';
    const r = await executeAction(refOf('input'), 'fill', { value: 'hi' });
    expect(r.effect.valueChanged).toBe(true);
    expect(r.effect.defaultPrevented).toBe(false);
  });

  it('valueChanged=false when filling the same value', async () => {
    document.body.innerHTML = '<input value="hi" />';
    const input = document.querySelector('input') as HTMLInputElement;
    input.value = 'hi';
    const r = await executeAction(refs.refFor(input), 'fill', { value: 'hi' });
    expect(r.effect.valueChanged).toBe(false);
  });

  it('valueChanged=false for a non-fill action on an input', async () => {
    document.body.innerHTML = '<input value="hi" />';
    const r = await executeAction(refOf('input'), 'click');
    expect(r.effect.valueChanged).toBe(false);
  });

  it('clear sets valueChanged=true and empties the value', async () => {
    document.body.innerHTML = '<input value="hi" />';
    const input = document.querySelector('input') as HTMLInputElement;
    input.value = 'hi';
    const r = await executeAction(refs.refFor(input), 'clear');
    expect(r.effect.valueChanged).toBe(true);
    expect(input.value).toBe('');
  });

  it('select to a REAL option reports valueChanged=true', async () => {
    document.body.innerHTML =
      '<select><option value="a">A</option><option value="b">B</option></select>';
    const r = await executeAction(refOf('select'), 'select', { value: 'b' });
    expect(r.effect.valueChanged).toBe(true);
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('b');
  });

  /**
   * Selecting an option that does not exist is REFUSED, not performed and reported.
   *
   * This used to be deliberate: assign the value, let the browser reject it, and report the
   * resulting `valueChanged` delta as proof the option never took. That reasoning only holds if
   * nobody is listening. Setting an unmatched value drives `selectedIndex` to -1, so `el.value`
   * becomes `''` — and we then dispatched `change`. Reported from a real session: the app read the
   * empty value in its change handler and persisted it, corrupting the stored language setting.
   *
   * So the "detectable no-op" was neither. It mutated the app into a state no user could reach, and
   * it did so through the app's own handler — Reticle causing the defect it exists to catch. This is
   * the same rule the readonly/disabled refusal already applies: if a real user could not do it,
   * forcing it is not a test, it is damage.
   */
  it('select to a NON-EXISTENT option is refused before anything is dispatched', async () => {
    document.body.innerHTML = '<select><option value="a">A</option></select>';
    const sel = document.querySelector('select') as HTMLSelectElement;
    let changes = 0;
    sel.addEventListener('change', () => (changes += 1));
    await expect(
      executeAction(refs.refFor(sel), 'select', { value: 'does-not-exist' }),
    ).rejects.toThrow(/no <option>/i);
    expect(sel.value, 'the existing selection must survive a refused select').toBe('a');
    expect(
      changes,
      'a refused select must not fire change — that is how the app got corrupted',
    ).toBe(0);
  });

  it('the refusal lists the options that DO exist, so the retry is one call away', async () => {
    document.body.innerHTML =
      '<select><option value="en">English</option><option value="fr">French</option></select>';
    const sel = document.querySelector('select') as HTMLSelectElement;
    await expect(executeAction(refs.refFor(sel), 'select', { value: 'English' })).rejects.toThrow(
      // No /s flag: the browser package compiles to ES2017 for webpack 4 (issue #680), and the
      // dotAll flag needs ES2018. [\s\S] matches the same newlines here.
      /en[\s\S]*fr|fr[\s\S]*en/,
    );
  });

  it('clear on a non-field element THROWS instead of reporting silent success', async () => {
    document.body.innerHTML = '<div>not a field</div>';
    await expect(executeAction(refOf('div'), 'clear')).rejects.toThrow(/cannot clear/);
  });
});

describe('action effect: domMutatedWithin', () => {
  it('counts mutations triggered by the action handler', async () => {
    document.body.innerHTML = '<button>add</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    button.addEventListener('click', () => {
      const span = document.createElement('span');
      span.textContent = 'new';
      document.body.appendChild(span);
    });
    const r = await executeAction(refs.refFor(button), 'click');
    expect(r.effect.domMutatedWithin).toBeGreaterThanOrEqual(1);
  });

  it('is 0 when nothing changes the DOM', async () => {
    document.body.innerHTML = '<button>noop</button>';
    const r = await executeAction(refOf('button'), 'click');
    expect(r.effect.domMutatedWithin).toBe(0);
  });
});

describe('action effect: appeared', () => {
  it('reports the text the action put on the page, not just that something changed', async () => {
    // The login shape. `domMutatedWithin: 7` is true and useless: it says the click did SOMETHING
    // without saying the app rejected you. An agent reads ok/settled/mutated and moves on.
    document.body.innerHTML = '<button>Sign in</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    button.addEventListener('click', () => {
      const err = document.createElement('div');
      err.textContent = 'Invalid email or password';
      document.body.appendChild(err);
    });
    const r = await executeAction(refs.refFor(button), 'click');
    expect(r.effect.appeared).toContain('Invalid email or password');
  });

  it('reports text swapped in by a character-data change, not only new nodes', async () => {
    document.body.innerHTML = '<button>Save</button><div id="s">Ready</div>';
    const button = document.querySelector('button') as HTMLButtonElement;
    button.addEventListener('click', () => {
      const status = document.getElementById('s');
      if (null !== status) status.textContent = 'Could not save';
    });
    const r = await executeAction(refs.refFor(button), 'click');
    expect(r.effect.appeared).toContain('Could not save');
  });

  it('is OMITTED when the action added no text — absence means "nothing was said"', async () => {
    document.body.innerHTML = '<button>noop</button>';
    const r = await executeAction(refOf('button'), 'click');
    expect(r.effect.appeared).toBeUndefined();
  });

  it('is omitted when the DOM changed but silently — a class toggle says nothing to a reader', async () => {
    document.body.innerHTML = '<button>toggle</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    button.addEventListener('click', () => button.classList.add('active'));
    const r = await executeAction(refs.refFor(button), 'click');
    expect(r.effect.domMutatedWithin).toBeGreaterThanOrEqual(1);
    expect(r.effect.appeared).toBeUndefined();
  });

  it('truncates a large render rather than returning a whole page of text', async () => {
    document.body.innerHTML = '<button>load</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    button.addEventListener('click', () => {
      const big = document.createElement('div');
      big.textContent = 'x'.repeat(5000);
      document.body.appendChild(big);
    });
    const r = await executeAction(refs.refFor(button), 'click');
    expect(r.effect.appeared).toBeDefined();
    expect((r.effect.appeared ?? '').length).toBeLessThan(300);
  });

  it('does NOT echo the text the agent itself just typed', async () => {
    // Found by driving: filling a textarea reported appeared:"<the value I passed in>". The field
    // is meant to be what the APP said; handing the caller its own input back is noise wearing the
    // name of evidence, and `valueChanged` already reports that the write landed.
    // A textarea carries its value in a CHILD TEXT NODE, so a controlled one re-rendering after
    // your keystroke mutates characterData with your own string. Filling the sibling <input> in
    // the same live view produced no `appeared` at all, which is what identified the mechanism.
    document.body.innerHTML = '<textarea>old</textarea>';
    const ta = document.querySelector('textarea') as HTMLTextAreaElement;
    ta.addEventListener('input', () => {
      const child = ta.firstChild;
      if (null !== child) child.textContent = ta.value;
    });
    const r = await executeAction(refs.refFor(ta), 'fill', { value: 'what shipped today' });
    expect(r.effect.valueChanged).toBe(true);
    expect(r.effect.appeared).toBeUndefined();
  });

  it('ignores a bare counter tick — an animated number is not the app saying something', async () => {
    // Found by driving the Hostile fixture, which mutates a counter every 16ms. Clicking its
    // "Fire failing request" button returned appeared:"409" — the ticker, not the fault. A
    // fragment with no letters at all carries no message a reader can act on, and a bare number
    // is exactly what a count-up animation emits into the settle window.
    document.body.innerHTML = '<button>go</button><span id="tick">408</span>';
    const button = document.querySelector('button') as HTMLButtonElement;
    button.addEventListener('click', () => {
      const tick = document.getElementById('tick');
      if (null !== tick) tick.textContent = '409';
    });
    const r = await executeAction(refs.refFor(button), 'click');
    expect(r.effect.domMutatedWithin).toBeGreaterThanOrEqual(1);
    expect(r.effect.appeared).toBeUndefined();
  });

  it('keeps a number that comes WITH words — that one is a message', async () => {
    document.body.innerHTML = '<button>go</button><span id="o"></span>';
    const button = document.querySelector('button') as HTMLButtonElement;
    button.addEventListener('click', () => {
      const out = document.getElementById('o');
      if (null !== out) out.textContent = 'status 500';
    });
    const r = await executeAction(refs.refFor(button), 'click');
    expect(r.effect.appeared).toContain('status 500');
  });

  it('still reports what the app said ABOUT the input it received', async () => {
    // The exclusion is exact-match only, so an app that quotes your input back inside its own
    // sentence is still reported — that IS the app talking.
    document.body.innerHTML = '<input /><div id="out"></div>';
    const input = document.querySelector('input') as HTMLInputElement;
    input.addEventListener('input', () => {
      const out = document.getElementById('out');
      if (null !== out) out.textContent = `No results for ${input.value}`;
    });
    const r = await executeAction(refs.refFor(input), 'fill', { value: 'zzz' });
    expect(r.effect.appeared).toContain('No results for zzz');
  });
});

describe('action effect: unresolvable ref', () => {
  it('rejects when the ref no longer resolves (tool did not dispatch)', async () => {
    document.body.innerHTML = '<button>gone</button>';
    const ref = refOf('button');
    document.body.innerHTML = '';
    await expect(executeAction(ref, 'click')).rejects.toThrow();
  });
});

describe('executeSequence effects', () => {
  it('returns one effect per step, all dispatched', async () => {
    document.body.innerHTML = '<input /><button>go</button>';
    const inputRef = refOf('input');
    const buttonRef = refOf('button');
    const r = await executeSequence([
      { ref: inputRef, action: 'fill', args: { value: 'x' } },
      { ref: buttonRef, action: 'click' },
    ]);
    expect(r.effects).toHaveLength(2);
    expect(r.effects.every((e) => e.dispatched)).toBe(true);
  });
});

describe('command registry passthrough', () => {
  it('ACT handler returns an effect block', async () => {
    document.body.innerHTML = '<button>Save</button>';
    const ref = refOf('button');
    const reg = createCommandRegistry();
    const handler = reg.get(ReticleCommand.ACT);
    if (handler === undefined) throw new Error('no act handler');
    const out = (await handler({ ref, action: 'click' })) as { effect?: unknown };
    expect(out.effect).toBeDefined();
  });
});

describe('action result: hover enter/leave warning', () => {
  beforeEach(() => {
    adapters.length = 0;
  });
  afterEach(() => {
    adapters.length = 0;
  });

  it('warns when the adapter reports the hover target has enter/leave handlers', async () => {
    registerAdapter({
      name: 'mock-hover',
      identify: () => null,
      hasHoverHandlers: () => true,
    });
    document.body.innerHTML = '<button>x</button>';
    const r = await executeAction(refOf('button'), 'hover');
    expect(r.warning).toBe(ActionWarning.HOVER_NATIVE_ENTER_LEAVE);
  });

  it('no warning when the adapter reports no hover handlers', async () => {
    registerAdapter({
      name: 'mock-hover',
      identify: () => null,
      hasHoverHandlers: () => false,
    });
    document.body.innerHTML = '<button>x</button>';
    const r = await executeAction(refOf('button'), 'hover');
    expect(r.warning).toBeUndefined();
  });

  it('no warning for a non-hover action even when handlers are present', async () => {
    registerAdapter({
      name: 'mock-hover',
      identify: () => null,
      hasHoverHandlers: () => true,
    });
    document.body.innerHTML = '<button>x</button>';
    const r = await executeAction(refOf('button'), 'click');
    expect(r.warning).toBeUndefined();
  });

  it('no warning (no-op-safe) when no adapter is installed', async () => {
    document.body.innerHTML = '<button>x</button>';
    const r = await executeAction(refOf('button'), 'hover');
    expect(r.warning).toBeUndefined();
  });

  it('improved hover dispatches a bubbling mouseover with relatedTarget', async () => {
    document.body.innerHTML = '<button>x</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    let seen = false;
    let related: EventTarget | null = null;
    document.body.addEventListener('mouseover', (e) => {
      seen = true;
      related = e.relatedTarget;
    });
    await executeAction(refs.refFor(button), 'hover');
    expect(seen).toBe(true);
    expect(related).not.toBeNull();
  });
});

describe('action result: testid normalization', () => {
  it('includes data-testid of the resolved element', async () => {
    document.body.innerHTML = '<button data-testid="pay-btn">Pay</button>';
    const r = await executeAction(refOf('button'), 'click', { confirmDangerous: true });
    expect(r.testid).toBe('pay-btn');
  });

  it('omits testid when the element has none', async () => {
    document.body.innerHTML = '<button>Pay</button>';
    const r = await executeAction(refOf('button'), 'click', { confirmDangerous: true });
    expect(r.testid).toBeUndefined();
  });

  it('executeSequence returns per-step testids where present', async () => {
    document.body.innerHTML = '<button data-testid="a">A</button><button>B</button>';
    const out = await executeSequence([
      { ref: refOf('[data-testid="a"]'), action: 'click' },
      { ref: refOf('button:not([data-testid])'), action: 'click' },
    ]);
    expect(out.steps).toHaveLength(2);
    expect(out.steps[0]?.testid).toBe('a');
    expect(out.steps[1]?.testid).toBeUndefined();
  });

  /**
   * A sequence step reported ONLY its testid, while a single act reports role+name and
   * component/source too. Every app without testids therefore compiled every sub-step to a volatile
   * ref, the flow saved the degraded `unresolved` sentinel, and replay drifted — measured on 7 of 7
   * apps in a field sweep. The narrowing is the whole bug: the anchors exist, they were dropped on
   * the way out.
   */
  it('executeSequence carries the same anchors a single act does', async () => {
    document.body.innerHTML = '<button>Pay now</button>';
    const out = await executeSequence([
      { ref: refOf('button'), action: 'click', args: { confirmDangerous: true } },
    ]);
    expect(out.steps[0]?.role).toBe('button');
    expect(out.steps[0]?.name).toBe('Pay now');
  });
});

/**
 * `occludedBy` is the actionable half of an occlusion report, and nothing was holding it.
 *
 * `hitTestOccluder` is well covered in occlusion.test.ts — it returns the overlay element. What was
 * not covered is the PLUMBING from there to `effect.occludedBy`, and a mutation proved it: replacing
 * `occludedBy: geometry.occludedBy` with `occludedBy: null` failed ZERO tests. `occluded: true`
 * alone tells an agent it is blocked; only `occludedBy` tells it by what, which is the difference
 * between "I cannot proceed" and "dismiss e16 and retry".
 *
 * Verified live against bench-app before writing this, so the behaviour being pinned is the observed
 * one rather than the one I assumed:
 *
 *   effect: { occluded: true, occludedBy: "e16" }
 *   warning: "target is visually occluded by another element; a real user could not click it
 *             (synthetic dispatch still delivered the event) — dismiss the overlay or scroll clear"
 */
describe('action effect: occludedBy names the blocker', () => {
  /** jsdom has no layout: give the target a real rect and put `overlay` on top of its centre. */
  function overlayOver(target: Element, overlay: Element): void {
    Object.defineProperty(target, 'getBoundingClientRect', {
      value: () => new DOMRect(0, 0, 40, 20),
      configurable: true,
    });
    Object.defineProperty(document, 'elementFromPoint', {
      value: () => overlay,
      configurable: true,
      writable: true,
    });
  }

  afterEach(() => {
    Reflect.deleteProperty(document, 'elementFromPoint');
  });

  it('reports a ref that RESOLVES to the covering element, not merely a non-null value', async () => {
    document.body.innerHTML = '<button>Save</button><div id="sheet"></div>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const overlay = document.querySelector('#sheet') as HTMLElement;
    overlayOver(button, overlay);

    const r = await executeAction(refs.refFor(button), 'click');
    expect(r.effect.occluded).toBe(true);
    const by = r.effect.occludedBy;
    expect(by, 'an occlusion the agent cannot name is one it cannot clear').not.toBeNull();
    // The property that makes it actionable: the ref must address the overlay itself.
    expect(refs.resolve(String(by))).toBe(overlay);
  });

  it('is null when nothing covers the target — absence must keep meaning "clear"', async () => {
    document.body.innerHTML = '<button>Save</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    Object.defineProperty(button, 'getBoundingClientRect', {
      value: () => new DOMRect(0, 0, 40, 20),
      configurable: true,
    });
    Object.defineProperty(document, 'elementFromPoint', {
      value: () => button,
      configurable: true,
      writable: true,
    });
    const r = await executeAction(refs.refFor(button), 'click');
    expect(r.effect.occluded).toBe(false);
    expect(r.effect.occludedBy).toBeNull();
  });
});
