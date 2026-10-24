/**
 * A session's journal as the App Graph's driven steps: what each act pressed, anchored the way a
 * flow anchors it, the events of its own window, and whether what it declared held.
 */
import { describe, expect, it } from 'vitest';
import { EventType, type JournalAction, type ReticleEvent } from '@reticlehq/core';
import { journalSteps } from './journal-steps.js';

const action = (over: Partial<JournalAction> & Pick<JournalAction, 'tool'>): JournalAction => ({
  v: 1,
  actionId: 'a1',
  args: {},
  tRange: { from: 0, to: 0 },
  at: 0,
  ...over,
});
const ev = (type: string, t: number, data: Record<string, unknown> = {}): ReticleEvent =>
  ({ type, t, data }) as unknown as ReticleEvent;

describe("a session's journal as driven steps", () => {
  it('anchors an act by its test id, or its role and name, and keeps its own window', () => {
    const events = [
      ev(EventType.ROUTE_CHANGE, 5, { pathname: '/' }),
      ev(EventType.ROUTE_CHANGE, 150, { pathname: '/memory' }),
      ev(EventType.NET_REQUEST, 400, { method: 'POST', url: '/api/facts' }),
    ];
    const steps = journalSteps(
      [
        action({
          tool: 'reticle_act_and_wait',
          args: { target: { testid: 'nav-memory' }, action: 'click' },
          tRange: { from: 100, to: 200 },
          effect: { verified: 'yes' },
        }),
        action({
          tool: 'reticle_act',
          args: { target: { role: 'button', name: 'Save' }, action: 'click' },
          tRange: { from: 350, to: 450 },
        }),
      ],
      events,
    );
    expect(steps.map((s) => s.anchor)).toEqual([
      { by: 'testid', value: 'nav-memory' },
      { by: 'role', value: 'button', name: 'Save' },
    ]);
    expect(steps[0]?.since).toBe(100);
    expect(steps[0]?.window.map((e) => e.t)).toEqual([150]);
    expect(steps[0]?.held).toBe(true);
    expect(steps[1]?.window.map((e) => e.t)).toEqual([400]);
    expect(steps[1]?.held).toBeUndefined();
  });

  it("credits a sequence's window to its last step only, and takes each step's verdict", () => {
    // A sequence journals one window for all its steps: crediting what happened in it to every step
    // would say a request came from controls that did not send it.
    const steps = journalSteps(
      [
        action({
          tool: 'reticle_act_sequence',
          args: {
            steps: [
              { target: { testid: 'open' }, action: 'click' },
              { target: { testid: 'save' }, action: 'click' },
            ],
          },
          tRange: { from: 100, to: 500 },
        }),
        action({
          tool: 'reticle_act_sequence',
          args: { step: 1 },
          effect: { verified: 'no' },
          tRange: { from: 480, to: 480 },
        }),
      ],
      [ev(EventType.NET_REQUEST, 300, { method: 'POST', url: '/api/x' })],
    );
    expect(steps.map((s) => s.window.length)).toEqual([0, 1]);
    expect(steps.map((s) => s.held)).toEqual([undefined, false]);
  });

  it('leaves out an act by ref alone, which names no element a later run can find', () => {
    expect(
      journalSteps([action({ tool: 'reticle_act', args: { ref: 'e12', action: 'click' } })], []),
    ).toEqual([]);
  });

  it('leaves out reads and navigation: they press nothing', () => {
    expect(
      journalSteps(
        [
          action({ tool: 'reticle_look', args: { action: 'page' } }),
          action({ tool: 'reticle_navigate', args: { url: '/x' } }),
        ],
        [],
      ),
    ).toEqual([]);
  });
});
