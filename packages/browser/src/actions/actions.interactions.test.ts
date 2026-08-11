import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventType } from '@reticlehq/core';
import { createCommandRegistry } from '../commands/commands.js';
import { executeAction } from './actions.js';
import { installScroll } from '../observers/scroll.js';
import { installOverlay } from '../presenter/overlay.js';
import { refs } from '../dom/refs.js';

describe('drag', () => {
  it('fires a pointer/mouse drag from source to target (async, yields frames)', async () => {
    document.body.innerHTML = '<div id="a">A</div><div id="b">B</div>';
    const a = document.getElementById('a') as HTMLElement;
    const b = document.getElementById('b') as HTMLElement;
    const down = vi.fn();
    const up = vi.fn();
    a.addEventListener('mousedown', down);
    b.addEventListener('mouseup', up);
    await executeAction(refs.refFor(a), 'drag', { toRef: refs.refFor(b) });
    expect(down).toHaveBeenCalled();
    expect(up).toHaveBeenCalled();
  });
});

describe('blur → focusout (React commit-on-blur)', () => {
  it('dispatches a bubbling focusout so delegated listeners fire', () => {
    document.body.innerHTML = '<input />';
    const input = document.querySelector('input') as HTMLInputElement;
    const onFocusOut = vi.fn();
    document.addEventListener('focusout', onFocusOut);
    input.focus();
    void executeAction(refs.refFor(input), 'blur');
    expect(onFocusOut).toHaveBeenCalled();
    document.removeEventListener('focusout', onFocusOut);
  });
});

describe('hover holdMs', () => {
  it('resolves after the dwell so timer-gated reveals can mount', async () => {
    document.body.innerHTML = '<div id="h">hover</div>';
    const el = document.getElementById('h') as HTMLElement;
    const r = await executeAction(refs.refFor(el), 'hover', { holdMs: 20 });
    expect(r).toMatchObject({ ok: true, action: 'hover' });
    expect(r.effect.dispatched).toBe(true);
  });
});

describe('scroll observer', () => {
  it('emits a scroll position event', () => {
    const emit = vi.fn();
    const stop = installScroll(emit);
    window.dispatchEvent(new Event('scroll'));
    const scrollEvents = emit.mock.calls.filter((c) => c[0] === EventType.SCROLL_POSITION);
    expect(scrollEvents.length).toBeGreaterThan(0);
    stop();
  });
});

describe('webmcp passthrough', () => {
  afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>)['modelContext'];
  });

  it('calls a navigator.modelContext tool via the act command', async () => {
    const callTool = vi.fn((name: string) => Promise.resolve({ called: name }));
    (navigator as unknown as Record<string, unknown>)['modelContext'] = { callTool };
    const reg = createCommandRegistry();
    const handler = reg.get('act');
    if (handler === undefined) throw new Error('no act handler');
    const result = await handler({
      action: 'webmcp',
      args: { tool: 'search', params: { q: 'x' } },
    });
    expect(callTool).toHaveBeenCalledWith('search', { q: 'x' });
    expect(result).toEqual({ called: 'search' });
  });

  it('blocks dangerous tools without explicit confirmation', async () => {
    const callTool = vi.fn(() => Promise.resolve({ ok: true }));
    (navigator as unknown as Record<string, unknown>)['modelContext'] = { callTool };
    const reg = createCommandRegistry();
    const handler = reg.get('act');
    if (handler === undefined) throw new Error('no act handler');
    await expect(
      handler({ action: 'webmcp', args: { tool: 'delete_account', params: {} } }),
    ).rejects.toThrow(/confirmDangerous/);
    await handler({
      action: 'webmcp',
      args: { tool: 'delete_account', params: {}, confirmDangerous: true },
    });
    expect(callTool).toHaveBeenCalledOnce();
  });
});

describe('dangerous action confirmation', () => {
  it('blocks a destructive click until explicitly confirmed', async () => {
    document.body.innerHTML = '<button>Delete account</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const ref = refs.refFor(button);
    const clicked = vi.fn();
    button.addEventListener('click', clicked);
    await expect(executeAction(ref, 'click')).rejects.toThrow(/confirmDangerous/);
    expect(clicked).not.toHaveBeenCalled();
    await executeAction(ref, 'click', { confirmDangerous: true });
    expect(clicked).toHaveBeenCalledOnce();
  });
});

describe('dev overlay', () => {
  it('mounts and unmounts a status chip', () => {
    const handle = installOverlay();
    expect(document.querySelector('[data-reticle-overlay]')).not.toBeNull();
    handle.update({ connected: true, events: 3 });
    handle.destroy();
    expect(document.querySelector('[data-reticle-overlay]')).toBeNull();
  });
});

describe('fill without a value', () => {
  /**
   * A `fill` carrying no value must FAIL, not quietly empty the field.
   *
   * `asString(args['value'])` defaults to '', so a fill whose value never arrived was indistinguishable
   * from `clear` — it wiped whatever the user (or the app) had put there, dispatched a real input
   * event so React committed the empty string to state, and reported ok:true with no contradiction.
   *
   * This is easy to trigger: the tool takes the value NESTED (`{ref, action:'fill', args:{value}}`),
   * so passing `value` at the top level silently becomes a destructive clear. Measured on bench-app's
   * login form — "admin@reticle.dev" was wiped and the act reported success.
   *
   * `clear` already exists for emptying a field on purpose, and its own branch throws rather than
   * report a silent success for a target it cannot clear. Fill follows the same rule.
   */
  it('throws instead of silently clearing the field', async () => {
    document.body.innerHTML = '<input id="f" value="keep-me" />';
    const el = document.getElementById('f') as HTMLInputElement;
    await expect(executeAction(refs.refFor(el), 'fill', {})).rejects.toThrow(/value/i);
    expect(el.value, 'the existing value must survive a malformed fill').toBe('keep-me');
  });

  it('still fills normally when a value is given', async () => {
    document.body.innerHTML = '<input id="g" value="old" />';
    const el = document.getElementById('g') as HTMLInputElement;
    await executeAction(refs.refFor(el), 'fill', { value: 'new' });
    expect(el.value).toBe('new');
  });

  it('allows an explicit empty string, which is a deliberate clear', async () => {
    document.body.innerHTML = '<input id="h" value="old" />';
    const el = document.getElementById('h') as HTMLInputElement;
    await executeAction(refs.refFor(el), 'fill', { value: '' });
    expect(el.value).toBe('');
  });
});

describe('type and select refuse malformed calls too', () => {
  /**
   * Same family as the valueless fill: a missing argument defaulted to '' and turned a broken call
   * into a silent success. `type` appended nothing and reported ok:true — an agent believes it typed.
   */
  it('type throws instead of appending nothing', async () => {
    document.body.innerHTML = '<input id="t" value="abc" />';
    const el = document.getElementById('t') as HTMLInputElement;
    await expect(executeAction(refs.refFor(el), 'type', {})).rejects.toThrow(/text/i);
    expect(el.value).toBe('abc');
  });

  /**
   * The worst of the three: `select` with no value assigned '' to the <select>. No option carries
   * that value, so the browser sets selectedIndex to -1 — DESELECTING everything — and the action
   * reported ok:true. A form the agent believes it filled is now emptier than before it acted.
   */
  it('select throws instead of deselecting everything', async () => {
    document.body.innerHTML =
      '<select id="s"><option value="a">A</option><option value="b">B</option></select>';
    const el = document.getElementById('s') as HTMLSelectElement;
    el.value = 'b';
    await expect(executeAction(refs.refFor(el), 'select', {})).rejects.toThrow(/value/i);
    expect(el.value, 'the existing selection must survive').toBe('b');
  });

  it('select still works for an option that exists', async () => {
    document.body.innerHTML =
      '<select id="s3"><option value="a">A</option><option value="b">B</option></select>';
    const el = document.getElementById('s3') as HTMLSelectElement;
    await executeAction(refs.refFor(el), 'select', { value: 'b' });
    expect(el.value).toBe('b');
  });
});

describe('fill and type refuse fields a user could not edit', () => {
  /**
   * A synthetic fill can write where a person cannot.
   *
   * `readonly` and `disabled` block USER input, not scripted assignment — so the prototype value
   * setter sails straight through both. Measured: filling a `readonly` input reported
   * `ok:true, valueChanged:true` with NOTHING in the effect block marking it read-only, and a
   * `disabled` input reported the same with only `enabled:false` to hint at it. The agent is told it
   * edited a field, and the app is now in a state no user could have produced — so any conclusion
   * drawn from what follows is about software nobody can actually operate.
   *
   * This is the same rule the click path already applies with `occluded` ("a real user could not
   * click it"), and it matches Playwright, which refuses to fill a non-editable element rather than
   * forcing the value in.
   */
  it('refuses to fill a readonly input, leaving it untouched', async () => {
    document.body.innerHTML = '<input id="ro" value="locked" readonly />';
    const el = document.getElementById('ro') as HTMLInputElement;
    await expect(executeAction(refs.refFor(el), 'fill', { value: 'new' })).rejects.toThrow(
      /readonly/i,
    );
    expect(el.value).toBe('locked');
  });

  it('refuses to fill a disabled input, leaving it untouched', async () => {
    document.body.innerHTML = '<input id="di" value="locked" disabled />';
    const el = document.getElementById('di') as HTMLInputElement;
    await expect(executeAction(refs.refFor(el), 'fill', { value: 'new' })).rejects.toThrow(
      /disabled/i,
    );
    expect(el.value).toBe('locked');
  });

  it('refuses to type into a readonly input', async () => {
    document.body.innerHTML = '<input id="ro2" value="locked" readonly />';
    const el = document.getElementById('ro2') as HTMLInputElement;
    await expect(executeAction(refs.refFor(el), 'type', { text: 'x' })).rejects.toThrow(
      /readonly/i,
    );
    expect(el.value).toBe('locked');
  });

  it('still fills an ordinary editable input', async () => {
    document.body.innerHTML = '<input id="ok" value="old" />';
    const el = document.getElementById('ok') as HTMLInputElement;
    await executeAction(refs.refFor(el), 'fill', { value: 'new' });
    expect(el.value).toBe('new');
  });
});

describe('a contenteditable target is refused legibly', () => {
  /**
   * Rich-text editors (TipTap, Quill, ProseMirror, Slate, Lexical) are all `[contenteditable]`, and
   * `fill` handles only input/textarea — so an agent driving a comment box or CMS body gets
   * "cannot fill a <div>", which reads as "you picked the wrong element" when the truth is "this
   * surface is not supported yet". Naming it costs nothing and stops the reader hunting for a
   * better selector that does not exist.
   *
   * Support is deliberately NOT faked here: setting textContent would update the DOM while the
   * editor's own model kept the old value, and the tool would report ok:true for content the app
   * will never submit — a false green in exactly the apps the feature would be for.
   */
  it('names contenteditable rather than blaming the element type', async () => {
    document.body.innerHTML = '<div id="rt" contenteditable="true">hello</div>';
    const el = document.getElementById('rt') as HTMLElement;
    await expect(executeAction(refs.refFor(el), 'fill', { value: 'x' })).rejects.toThrow(
      /contenteditable/i,
    );
    expect(el.textContent, 'the existing content must not be touched').toBe('hello');
  });
});

/**
 * Hold-to-confirm controls were undriveable, and the agent's own workaround was to give up and ask
 * the human to click the button.
 *
 * Reported via `reticle_feedback` (`kind: gap`). Every action that touches an element pressed and
 * released in the same synchronous block, so any UI whose contract is *"the button is down for N
 * milliseconds"* could not be expressed. The reported case: `mousedown` starts a 1.2s fill, and a
 * `mouseup` before it completes cancels the confirm — deliberate anti-misclick design, and common
 * (hold-to-delete in dashboards, hold-to-record in chat, long-press menus).
 *
 * Nothing was misreported. `domMutatedWithin:7ms` was true and the absent DELETE was the app
 * behaving as designed. Reticle simply could not produce the input.
 *
 * `args.holdMs` on `click` rather than separate press/release actions, for the reason the report
 * gives: a single call owns both halves. An agent that presses and then errors, or hits its context
 * limit, would otherwise leave the page with a button held down and nobody to release it, and the
 * next tool call inherits a corrupted input state.
 */
describe('click holdMs — hold-to-confirm controls', () => {
  /** A control that fires only if the pointer stays down past `thresholdMs`. */
  function holdToConfirm(thresholdMs: number): { el: HTMLElement; fired: () => boolean } {
    // Neutral label on purpose. "Hold to delete" trips the destructive-action guard — correctly —
    // and these tests are about the hold mechanism, not about that guard.
    document.body.innerHTML = '<button id="armed">Press and hold</button>';
    const el = document.getElementById('armed') as HTMLElement;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let confirmed = false;
    el.addEventListener('mousedown', () => {
      timer = setTimeout(() => {
        confirmed = true;
      }, thresholdMs);
    });
    el.addEventListener('mouseup', () => {
      if (timer !== undefined) clearTimeout(timer);
    });
    return { el, fired: () => confirmed };
  }

  it('holds the pointer down long enough to arm the control', async () => {
    // One-sided on purpose: a sleep can overshoot on a loaded runner but never undershoot, so
    // "asked for 200ms, armed a 20ms control" cannot fail for machine reasons. The reverse
    // assertion — a short hold must NOT arm a long control — WOULD be a machine statement, and is
    // expressed relatively below instead.
    const { el, fired } = holdToConfirm(20);
    await executeAction(refs.refFor(el), 'click', { holdMs: 200 });
    expect(fired(), 'the press and release were still in one synchronous block').toBe(true);
  });

  /**
   * The half that actually catches a regression, expressed as a BOUND rather than a duration.
   *
   * The first version of this asserted that `holdMs: 5` fails to arm an 80ms control. That is a
   * statement about the machine: Windows timer granularity is ~15.6ms and worse under load, so a
   * 5ms sleep can genuinely exceed 80ms and arm it. **It failed on Windows CI, which is exactly the
   * failure mode CLAUDE.md describes — "fails only under parallel load, i.e. only in CI".**
   *
   * What is actually being defended is that the hold is CALLER-CONTROLLED rather than fixed: a hold
   * that always lasts the same time is indistinguishable from a click. Comparing two holds measured
   * on the same machine in the same run says that without asking the clock to behave.
   */
  it('a shorter hold is measurably shorter than a longer one', async () => {
    const { el } = holdToConfirm(5_000); // never fires; this test is about the measurement
    const brief = await executeAction(refs.refFor(el), 'click', { holdMs: 1 });
    const long = await executeAction(refs.refFor(el), 'click', { holdMs: 300 });
    expect(
      long.effect.heldMs,
      'both holds took the same time — the duration is not caller-controlled',
    ).toBeGreaterThan(brief.effect.heldMs ?? 0);
  });

  it('an ordinary click still works and is not slowed by the feature', async () => {
    document.body.innerHTML = '<button id="plain">Save</button>';
    const el = document.getElementById('plain') as HTMLElement;
    const clicked = vi.fn();
    el.addEventListener('click', clicked);
    const r = await executeAction(refs.refFor(el), 'click', {});
    expect(clicked).toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, action: 'click' });
  });

  it('reports the hold it actually achieved, so a caller can tell 1200 from 1204', async () => {
    // A lower bound only. A sleep never returns early, so this cannot fail on a slow machine — and
    // overshoot is the thing `heldMs` exists to disclose, not something to assert against.
    const { el } = holdToConfirm(5_000);
    const r = await executeAction(refs.refFor(el), 'click', { holdMs: 25 });
    expect(r.effect.heldMs, 'no way to tell a real hold from a claimed one').toBeGreaterThanOrEqual(
      25,
    );
  });
});
