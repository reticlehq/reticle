/**
 * A page on SDK 3.1 to 3.4 was version-skewed against every 3.5 daemon (#1343).
 *
 * 3.5 removed the `webmcp` action. Those SDKs still list it in the `contractParts` they send in
 * HELLO, and the daemon reported any name it did not have as skew, so every `act_and_wait` and
 * `assert` on such a page came back `unknown / version_skew`. A name the daemon retired is the
 * opposite of a name it has not met yet: the daemon never sends that action, so the page knowing it
 * changes nothing.
 *
 * The sentence also pointed the wrong way. It told the agent the page "was built against a newer
 * contract" while naming a page version older than the daemon.
 */

import { describe, expect, it } from 'vitest';
import {
  CONTRACT_FINGERPRINT,
  CONTRACT_PARTS,
  HelloMessageSchema,
  MessageKind,
  RETICLE_PROTOCOL_VERSION,
} from '@reticlehq/core';
import { describeSkew } from './version-skew.js';

/** What the published @reticlehq/core 3.4.0 announces, copied from its dist. */
const CONTRACT_PARTS_3_4_0 = {
  commands: [
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
  ],
  events: [
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
  ],
  actions: [
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
  ],
};

const DAEMON = { version: '3.6.0', contract: CONTRACT_FINGERPRINT, contractParts: CONTRACT_PARTS };
const FIX = 'update the SDK';

describe('a name the daemon retired is not skew', () => {
  it('a HELLO carrying the 3.4.0 contractParts produces no skew against this daemon', () => {
    const parsed = HelloMessageSchema.parse({
      kind: MessageKind.HELLO,
      protocolVersion: RETICLE_PROTOCOL_VERSION,
      sessionId: 'pinned-sdk',
      url: 'http://localhost:5173/',
      title: 'pinned',
      adapters: [],
      sdkVersion: '3.4.0',
      contract: 'deadbeef',
      contractParts: CONTRACT_PARTS_3_4_0,
    });
    const skew = describeSkew(
      {
        what: 'the page',
        version: parsed.sdkVersion,
        contract: parsed.contract,
        contractParts: parsed.contractParts,
        fix: FIX,
      },
      DAEMON,
    );
    expect(skew, 'every verdict on a 3.4 page was `unknown` because of this').toBeUndefined();
  });

  it('a genuinely unknown EVENT name is still reported', () => {
    const skew = describeSkew(
      {
        what: 'the page',
        version: '3.4.0',
        contract: 'deadbeef',
        contractParts: {
          ...CONTRACT_PARTS_3_4_0,
          events: [...CONTRACT_PARTS_3_4_0.events, 'gaze'],
        },
        fix: FIX,
      },
      DAEMON,
    );
    expect(skew).toContain('gaze');
    expect(skew, 'the retired name is not part of the complaint').not.toContain('webmcp');
  });
});

describe('the skew sentence says which side is behind', () => {
  const peerSpeaking = (version: string | undefined) => ({
    what: 'the page',
    version,
    contract: 'deadbeef',
    contractParts: { ...CONTRACT_PARTS, actions: [...CONTRACT_PARTS.actions, 'levitate'] },
    fix: FIX,
  });

  it('never calls an OLDER page newer', () => {
    const skew = describeSkew(peerSpeaking('3.4.0'), DAEMON) ?? '';
    expect(skew).toContain('levitate');
    expect(skew).not.toContain('newer contract');
  });

  it('calls a newer page newer', () => {
    expect(describeSkew(peerSpeaking('3.7.0'), DAEMON)).toContain('newer contract');
  });

  it('falls back to "newer contract" only when the page does not say its version', () => {
    expect(describeSkew(peerSpeaking(undefined), DAEMON)).toContain('newer contract');
  });
});
