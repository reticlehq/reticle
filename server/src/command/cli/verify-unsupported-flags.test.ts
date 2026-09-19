/**
 * `reticle verify` must never drop a flag it was handed and then answer a different question.
 *
 * Two flags were dropped on the floor, and each one produced a different kind of wrong answer
 * ([#993](https://github.com/reticlehq/reticle/issues/993)):
 *
 * `--expect` reached the predicate ONLY when a daemon already owned the port. On any other port
 * state the flag was discarded and the command fell through to the saved-flows path, so the reader
 * got the honest refusal for a question nobody asked — "No saved flows to verify" — with no mention
 * that a predicate had been supplied and ignored. Reproduced on the built CLI: `verify "" --port
 * <free> --timeout 1 --expect '<predicate>'` printed byte-identical output to the same command with
 * no `--expect` at all. That is the documented recovery for a client whose `reticle_*` tools never
 * loaded, so it fails for exactly the people with no other way to a verdict.
 *
 * `--storage-state` was parsed and accepted next to `--expect`, and the one-shot verdict path has
 * nowhere to put one: it grades the predicate against the tab the running daemon already owns. A
 * restricted-user absence assertion was therefore evaluated against a logged-in admin tab and
 * PASSED. That one is a false green, not a missing answer.
 *
 * Both are argument-level decisions, so both are settled before anything binds a port or launches a
 * browser — which is why every case here runs with neither.
 */

import { describe, expect, it } from 'vitest';
import { parseCliArgs } from './cli-parse.js';
import { portBusyMessage, routeVerify, VerifyRoute } from './cli-verify.js';
import { PortPresence } from '@/command/daemon/binding/port-presence.js';

const URL_ = 'http://localhost:3000';
const PORT = 4400;
const PREDICATE = '{"kind":"text","contains":"Admin"}';

describe('what verify does with --expect, once the port has been looked at', () => {
  it('takes the one-shot verdict when a daemon owns the port', () => {
    expect(routeVerify({ hasPredicate: true, presence: PortPresence.DAEMON, port: PORT })).toEqual({
      route: VerifyRoute.ADHOC,
    });
  });

  it.each([
    ['nothing is listening', PortPresence.FREE],
    ['a stranger holds the port', PortPresence.FOREIGN],
  ])('refuses rather than silently dropping the predicate when %s', (_label, presence) => {
    const plan = routeVerify({ hasPredicate: true, presence, port: PORT });
    expect(plan.route).toBe(VerifyRoute.REFUSE);
  });

  it.each([
    ['nothing is listening', PortPresence.FREE],
    ['a stranger holds the port', PortPresence.FOREIGN],
  ])(
    'names the flag it could not honour, and says the predicate did not run, when %s',
    (_label, presence) => {
      const plan = routeVerify({ hasPredicate: true, presence, port: PORT });
      const message = plan.route === VerifyRoute.REFUSE ? plan.message : '';
      expect(
        message,
        'a refusal that never mentions --expect answers a question nobody asked',
      ).toContain('--expect');
      expect(message).toContain(String(PORT));
      expect(message.toLowerCase()).toContain('did not run');
    },
  );

  it('offers a next command that actually gets the reader a daemon', () => {
    const plan = routeVerify({ hasPredicate: true, presence: PortPresence.FREE, port: PORT });
    const message = plan.route === VerifyRoute.REFUSE ? plan.message : '';
    expect(message).toContain('npx @reticlehq/server serve');
  });

  it('never reports the saved-flows refusal to somebody who supplied a predicate', () => {
    const plan = routeVerify({ hasPredicate: true, presence: PortPresence.FREE, port: PORT });
    const message = plan.route === VerifyRoute.REFUSE ? plan.message : '';
    expect(message).not.toContain('No saved flows to verify');
  });
});

/** The routes that already worked. A fix that quietly reshapes one of these is a regression. */
describe('what verify does without --expect', () => {
  it('replays saved flows when nothing is listening on the port', () => {
    expect(routeVerify({ hasPredicate: false, presence: PortPresence.FREE, port: PORT })).toEqual({
      route: VerifyRoute.FLOWS,
    });
  });

  it('replays saved flows when a stranger holds the port, as it always did', () => {
    expect(
      routeVerify({ hasPredicate: false, presence: PortPresence.FOREIGN, port: PORT }),
    ).toEqual({ route: VerifyRoute.FLOWS });
  });

  it('answers the busy-port message when a daemon owns the port', () => {
    expect(routeVerify({ hasPredicate: false, presence: PortPresence.DAEMON, port: PORT })).toEqual(
      { route: VerifyRoute.REFUSE, message: portBusyMessage(PORT) },
    );
  });
});

describe('--storage-state alongside --expect', () => {
  it('is refused by the parser, in either argument order', () => {
    const flagsFirst = parseCliArgs(
      ['verify', URL_, '--expect', PREDICATE, '--storage-state', 'restricted.json'],
      PORT,
    );
    const stateFirst = parseCliArgs(
      ['verify', URL_, '--storage-state', 'restricted.json', '--expect', PREDICATE],
      PORT,
    );
    expect(flagsFirst.kind).toBe('error');
    // Both orders are reported from the field, and an answer that depends on the order they were
    // typed in is a second bug wearing the first one's clothes.
    expect(stateFirst).toEqual(flagsFirst);
  });

  it('names both flags and what each one would have done', () => {
    const parsed = parseCliArgs(
      ['verify', URL_, '--expect', PREDICATE, '--storage-state', 'restricted.json'],
      PORT,
    );
    const message = 'error' === parsed.kind ? parsed.message : '';
    expect(message).toContain('--expect');
    expect(message).toContain('--storage-state');
  });

  it('is refused before anything can bind a port or launch a browser', () => {
    // The parser is the only thing that has run at this point, so the refusal is structural: there
    // is no `verify` command to dispatch, and the false green needs a browser to happen in.
    const parsed = parseCliArgs(
      ['verify', URL_, '--expect', PREDICATE, '--storage-state', 'restricted.json'],
      PORT,
    );
    expect(parsed.kind).not.toBe('verify');
  });
});

/** The combinations that are honoured must keep parsing exactly as they did. */
describe('the flag combinations verify does support', () => {
  it('carries --expect on its own', () => {
    expect(parseCliArgs(['verify', URL_, '--expect', PREDICATE], PORT)).toEqual({
      kind: 'verify',
      url: URL_,
      headless: true,
      port: PORT,
      expect: { kind: 'text', contains: 'Admin' },
    });
  });

  it('carries --storage-state on its own', () => {
    expect(parseCliArgs(['verify', URL_, '--storage-state', 'restricted.json'], PORT)).toEqual({
      kind: 'verify',
      url: URL_,
      headless: true,
      port: PORT,
      storageState: 'restricted.json',
    });
  });

  it('carries --session-id next to --expect, because the one-shot verdict does pin a tab', () => {
    expect(
      parseCliArgs(['verify', URL_, '--expect', PREDICATE, '--session-id', 's-42'], PORT),
    ).toEqual({
      kind: 'verify',
      url: URL_,
      headless: true,
      port: PORT,
      sessionId: 's-42',
      expect: { kind: 'text', contains: 'Admin' },
    });
  });

  it('still names the quoting when --expect is handed something that is not JSON', () => {
    const parsed = parseCliArgs(['verify', URL_, '--expect', '{kind: text}'], PORT);
    expect(parsed).toEqual({
      kind: 'error',
      message: '--expect needs a JSON predicate; could not parse: {kind: text}',
    });
  });
});
