/**
 * A wire name may leave the contract only by being retired (#1343).
 *
 * 3.5 removed `webmcp` from `ActionType`. `CONTRACT_PARTS` is derived from `ActionType`, so the daemon
 * stopped listing it, and every page on SDK 3.1 to 3.4 (which still lists it in HELLO) was reported
 * as version-skewed: every verdict on those pages came back `unknown`. The daemon now ignores a peer
 * name it has RETIRED, which only works if every removed name lands in `RETIRED_WIRE_NAMES`.
 *
 * `SHIPPED` is every name a published release has announced. A name in it must be either still in
 * the contract or retired; a name in the contract must be in it, so the list cannot fall behind.
 */

import { describe, expect, it } from 'vitest';
import { CONTRACT_PARTS, RETIRED_WIRE_NAMES } from './contract-fingerprint.js';

const SHIPPED: readonly string[] = [
  // commands
  'snapshot',
  'query',
  'match',
  'inspect',
  'act',
  'act_sequence',
  'animations',
  'narrate',
  'clock',
  'capabilities',
  'state_read',
  'storage_read',
  'scroll',
  'session_config',
  'presenter',
  'impact',
  'capture',
  'navigate',
  'refresh',
  'flows',
  'flow.progress',
  'plan',
  'head_read',
  // events
  'dom.added',
  'dom.removed',
  'dom.attr',
  'dom.text',
  'net.request',
  'net.pending',
  'net.stream',
  'perf',
  'route.change',
  'console.log',
  'console.warn',
  'console.error',
  'console.info',
  'console.debug',
  'error.uncaught',
  'visible.shown',
  'anim.start',
  'anim.end',
  'scroll.position',
  'reveal.shown',
  'signal',
  'state.change',
  'storage.change',
  'page.health',
  'context.opened',
  'dialog.opened',
  'render.commit',
  'focus.change',
  'field.change',
  'flow.recorded',
  'transport.overflow',
  'truncated',
  'blind-spot',
  'sdk.failed',
  'net.detail',
  'human.control',
  'human.mark',
  'download',
  'hud.used',
  // actions
  'click',
  'dblclick',
  'hover',
  'focus',
  'blur',
  'fill',
  'type',
  'clear',
  'select',
  'check',
  'uncheck',
  'submit',
  'press',
  'upload',
  'scrollIntoView',
  'scroll',
  'drag',
  'tap',
  'zoom',
  'webmcp',
];

const current = new Set([
  ...CONTRACT_PARTS.commands,
  ...CONTRACT_PARTS.events,
  ...CONTRACT_PARTS.actions,
]);

describe('retired wire names', () => {
  it('every shipped name is still in ActionType / EventType / ReticleCommand, or retired', () => {
    const dropped = SHIPPED.filter(
      (name) => !current.has(name) && !RETIRED_WIRE_NAMES.includes(name),
    );
    expect(
      dropped,
      'Removing a wire name skews every page on an older SDK that still announces it. Add it to ' +
        'RETIRED_WIRE_NAMES in contract-fingerprint.ts.',
    ).toEqual([]);
  });

  it('every name in the contract is recorded as shipped, so removing it later is caught', () => {
    expect(
      [...current].filter((name) => !SHIPPED.includes(name)),
      'A new wire name: add it to SHIPPED in this file.',
    ).toEqual([]);
  });

  it('a retired name is not still in the contract', () => {
    expect(RETIRED_WIRE_NAMES.filter((name) => current.has(name))).toEqual([]);
  });
});
