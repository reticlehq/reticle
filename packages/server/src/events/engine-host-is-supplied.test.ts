import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { MessageKind, RETICLE_PROTOCOL_VERSION, type HelloMessage } from '@reticlehq/core';
import { Session } from '../session/session.js';
import {
  clearCrashedRules,
  registerContradictionFold,
  runRegisteredFolds,
} from './contradiction-folds.js';

/**
 * The rules that decide a verdict ask whoever is running them to write down anything they could not
 * do. Nobody is obliged to answer -- a test with a fake session should not have to -- and the rules
 * carry on either way, because a missing note should cost a log line and never a verdict.
 *
 * The daemon IS obliged. If its own session stopped answering, every one of those records would stop
 * being written and nothing anywhere would go red, because a rule that is never reported looks
 * exactly like a rule that never had a problem.
 *
 * So this checks by CALLING, never by looking for a name. A method that exists and quietly does
 * nothing passes a name check and loses the record just the same.
 */

function hello(): HelloMessage {
  return {
    kind: MessageKind.HELLO,
    protocolVersion: RETICLE_PROTOCOL_VERSION,
    sessionId: 'demo',
    url: 'http://localhost/',
    title: 'Demo',
    adapters: [],
  };
}

const noopSocket = { send: () => undefined, close: () => undefined } as unknown as WebSocket;

/** Run something while collecting whatever the daemon log writes, then put the stream back. */
function whileWatchingTheLog(run: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    captured += String(chunk);
    return true;
  };
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

describe('the daemon answers what the rules ask of it', () => {
  it('really writes down a note the rules hand it', () => {
    const session = new Session(hello(), noopSocket, () => 0);
    const written = whileWatchingTheLog(() => {
      session.note('a_rule_could_not_run', { why: 'checking that this lands somewhere' });
    });
    expect(written).toContain('a_rule_could_not_run');
  });

  it('hands a re-check back in a state that still runs', () => {
    const session = new Session(hello(), noopSocket, () => 0);
    let ran = false;
    session.keepCallerContext(() => {
      ran = true;
    })();
    expect(ran, 'a wrapped re-check must still run, or every wait would stop in silence').toBe(
      true,
    );
  });

  it('reports a rule that threw to whoever asked, rather than swallowing it', () => {
    clearCrashedRules();
    const heard: string[] = [];
    const stopUsingTheBrokenRule = registerContradictionFold(() => {
      throw new Error('this rule is broken on purpose');
    });
    try {
      runRegisteredFolds([], { note: (event) => heard.push(event) });
    } finally {
      stopUsingTheBrokenRule();
      clearCrashedRules();
    }
    expect(heard).toContain('contradiction_fold_failed');
  });
});
