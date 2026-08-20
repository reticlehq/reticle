/**
 * A locally-answered handshake must not leave the client permanently toolless.
 *
 * When the daemon does not answer in time the proxy completes `initialize` itself, which is right: a
 * hang gives the agent no tools AND no diagnosis. But on a COLD start the proxy has never seen a
 * tool catalog, so the list it serves is empty, and the state that follows is self-sustaining:
 *
 *   1. `initialize` answered locally, catalog empty.
 *   2. `tools/list` queues, the queue expires, and it is answered with a transport-loss error.
 *   3. The proxy goes dormant. Its recovery is "the NEXT client request re-probes the port".
 *   4. A client holding zero tools never makes another request.
 *
 * Connected, initialized, and toolless for the rest of the session, with a human required to notice
 * and reconnect by hand. It is a plausible contributor to the population that attaches an agent and
 * then never calls anything.
 *
 * `notifications/tools/list_changed` is the protocol's own answer, and it is the only recovery here
 * that does not require the client to move first. Two halves, and BOTH are required: a client that
 * was never told the list can change has no reason to honour the notification, so declaring
 * `listChanged` is not decoration.
 */
import { describe, expect, it } from 'vitest';
import { localInitializeResponse, TOOLS_CHANGED_NOTIFICATION } from './proxy-handshake.js';

const initialize = (id: number | string = 1): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: 'x' } });

interface InitResult {
  result?: { capabilities?: { tools?: { listChanged?: boolean } }; protocolVersion?: string };
}

const parse = (line: string | null): InitResult => {
  if (null === line) throw new Error('expected a handshake response');
  return JSON.parse(line) as InitResult;
};

describe('a locally-answered handshake can be corrected later', () => {
  it('declares that the tool list can change, so the client will honour the notification', () => {
    // Without this the notification is a message into the void: a spec-compliant client has no
    // reason to re-list a catalog it was never told could change.
    expect(
      parse(localInitializeResponse(initialize())).result?.capabilities?.tools?.listChanged,
    ).toBe(true);
  });

  it('uses the protocol notification, not a name of our own', () => {
    // A client honours the method the specification names and ignores anything else, so this string
    // is a wire contract with every MCP client rather than an internal label.
    expect(TOOLS_CHANGED_NOTIFICATION).toBe('notifications/tools/list_changed');
  });

  it('still echoes the protocol version the client proposed', () => {
    // Guarding the change above: answering with a version the client did not offer is its own
    // handshake failure, and the capability edit sits in the same object literal.
    expect(parse(localInitializeResponse(initialize())).result?.protocolVersion).toBe('x');
  });

  it('answers a request and never a notification', () => {
    // A notification carries no id and expects no reply; answering one is a protocol error.
    const notification = JSON.stringify({ jsonrpc: '2.0', method: 'initialize' });
    expect(localInitializeResponse(notification)).toBeNull();
  });

  it('ignores anything that is not an initialize', () => {
    expect(
      localInitializeResponse(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })),
    ).toBeNull();
  });
});
