import { describe, it, expect } from 'vitest';
import { demoPlan } from './tutorial.js';

/**
 * A scripted demo drive on the USER'S OWN app.
 *
 * `reticle_verify { action: "explore" }` already drives somebody's app, and it needs a model and a
 * key. A tutorial must work before either exists, so this one is scripted: the same four steps the
 * tutorial teaches, against whatever is actually on the page.
 *
 * The design content here is not the sequence — the tutorial already has that. It is SAFETY. This
 * runs unattended on an app the author has never seen, so picking the wrong control is not a bad
 * demo, it is somebody's data. The rule is therefore the conservative one: demonstrate on a control
 * that cannot commit anything, and if the page offers none, say so rather than lower the bar.
 */
const el = (ref: string, name: string, role = 'button') => ({ ref, name, role });

describe('demoPlan', () => {
  it('picks a safe control and builds the call that proves it', () => {
    const plan = demoPlan([el('e1', 'Open settings')]);
    expect(plan.ok).toBe(true);
    expect(plan.ok && plan.ref).toBe('e1');
    expect(plan.ok && plan.call).toContain('reticle_act_and_wait');
  });

  it('never picks a control whose name reads as destructive', () => {
    const plan = demoPlan([el('e1', 'Delete account'), el('e2', 'View profile')]);
    expect(plan.ok && plan.ref).toBe('e2');
  });

  it.each([
    'Delete row',
    'Remove member',
    'Deploy to production',
    'Pay now',
    'Cancel subscription',
  ])('refuses %s', (name) => {
    const plan = demoPlan([el('e1', name)]);
    expect(plan.ok, name).toBe(false);
  });

  it('REFUSES rather than demonstrating on something risky when nothing is safe', () => {
    const plan = demoPlan([el('e1', 'Delete everything')]);
    expect(plan.ok).toBe(false);
    expect(false === plan.ok ? plan.because : '').toContain('safe');
  });

  it('refuses an empty page rather than inventing a target', () => {
    expect(demoPlan([]).ok).toBe(false);
  });

  it('declares a consequence, because a demo that proves nothing teaches the wrong lesson', () => {
    const plan = demoPlan([el('e1', 'Open settings')]);
    expect(plan.ok && plan.call).toContain('until');
  });
});
