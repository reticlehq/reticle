import { describe, expect, it, beforeEach } from 'vitest';
import { ActionType } from '@reticlehq/core';
import { executeAction } from './actions.js';
import { refs } from '../dom/refs.js';

/**
 * #393: `press` synthesised a KeyboardEvent with no modifier flags, so a Cmd+K / Ctrl+Shift
 * shortcut arrived with metaKey/ctrlKey/shiftKey/altKey all false. The app's own check never
 * matched, nothing observable happened, and Reticle reported no error -- a false negative, the
 * expensive direction.
 */
describe('press sets modifier flags (#393)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('fires a metaKey+shiftKey shortcut the app only responds to with both', async () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    let fired = false;
    el.addEventListener('keydown', (e) => {
      if (e.metaKey && e.shiftKey) fired = true;
    });
    await executeAction(refs.refFor(el), ActionType.PRESS, {
      key: 'k',
      modifiers: ['Meta', 'Shift'],
    });
    expect(fired).toBe(true);
  });

  it('sets each flag independently and leaves the rest false', async () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    const seen: KeyboardEvent[] = [];
    el.addEventListener('keydown', (e) => seen.push(e));
    await executeAction(refs.refFor(el), ActionType.PRESS, { key: 'a', modifiers: ['Control'] });
    expect(seen[0]?.ctrlKey).toBe(true);
    expect(seen[0]?.metaKey).toBe(false);
    expect(seen[0]?.altKey).toBe(false);
  });

  it('accepts the common aliases (Cmd, Option)', async () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    let ok = false;
    el.addEventListener('keydown', (e) => {
      if (e.metaKey && e.altKey) ok = true;
    });
    await executeAction(refs.refFor(el), ActionType.PRESS, {
      key: 'p',
      modifiers: ['Cmd', 'Option'],
    });
    expect(ok).toBe(true);
  });

  it('also sets the flags on keyup', async () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    let upMeta = false;
    el.addEventListener('keyup', (e) => {
      upMeta = e.metaKey;
    });
    await executeAction(refs.refFor(el), ActionType.PRESS, { key: 'k', modifiers: ['Meta'] });
    expect(upMeta).toBe(true);
  });

  it('with no modifiers every flag stays false (unchanged behaviour)', async () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    let anyMod = true;
    el.addEventListener('keydown', (e) => {
      anyMod = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
    });
    await executeAction(refs.refFor(el), ActionType.PRESS, { key: 'Enter' });
    expect(anyMod).toBe(false);
  });
});
