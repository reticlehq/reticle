/**
 * A daemon skew is told to the agent whose MCP server announced it, and to nobody else (#1136).
 *
 * Two agents share one daemon. A attaches with a different MCP server version; B's matches. The
 * daemon-wide queue handed A's "restart your MCP server, or run `reticle stop`" to whichever tool
 * call came next, which was B's, and following that advice cuts every agent on the daemon. A, the
 * one that was actually skewed, never heard it: the nudge is delivered once.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CONTRACT_FINGERPRINT } from '@reticlehq/core';
import { Bridge } from '@/portal/bridge/bridge.js';
import { makeDeps } from '@/portal/bridge/bridge.test-harness.js';
import { TOOLS, type ToolDeps } from '@/surface/tools/tools.js';
import { runTool } from '@/surface/tools/invoke-tool.js';
import { SERVER_VERSION } from './identity/server-version.js';
import { agentPeerSkew } from './peer-announce.js';
import { connectionSkew, resetVersionSkew, takeVersionSkew } from './version-nudge.js';

let bridge: Bridge;
let shared: ToolDeps;

beforeAll(async () => {
  bridge = new Bridge({ port: 0 });
  await bridge.ready;
  shared = makeDeps(bridge);
});

afterAll(async () => {
  await bridge.close();
});

beforeEach(() => resetVersionSkew());

/** One MCP connection: the shared daemon deps, plus whatever that connection's own peer said. */
function connection(version: string, contract: string): ToolDeps {
  const skew = agentPeerSkew(version, contract);
  return skew === undefined ? shared : { ...shared, peerSkew: connectionSkew(skew) };
}

const sessions = (deps: ToolDeps): Promise<{ version_skew?: { pair: string; action: string } }> => {
  const tool = TOOLS.find((t) => 'reticle_sessions' === t.name);
  if (tool === undefined) throw new Error('no reticle_sessions');
  return runTool(tool, deps, {}) as Promise<{ version_skew?: { pair: string; action: string } }>;
};

describe('daemon skew belongs to one connection', () => {
  it("B's call carries nothing, and A's next call carries A's skew", async () => {
    const a = connection('0.0.1', 'deadbeef');
    const b = connection(SERVER_VERSION, CONTRACT_FINGERPRINT);

    const onB = await sessions(b);
    const onA = await sessions(a);

    expect(onB.version_skew, "B's server matches the daemon").toBeUndefined();
    expect(onA.version_skew?.pair).toBe('daemon');
    expect(onA.version_skew?.action).toContain('0.0.1');
  });

  it('is told to that connection once', async () => {
    const a = connection('0.0.1', 'deadbeef');

    await sessions(a);
    const again = await sessions(a);

    expect(again.version_skew).toBeUndefined();
  });

  it('never enters the daemon-wide queue, where any caller would take it', () => {
    expect(agentPeerSkew('0.0.1', 'deadbeef')).toBeDefined();

    expect(takeVersionSkew()).toBeUndefined();
  });

  it('says nothing for a peer that matches', () => {
    expect(agentPeerSkew(SERVER_VERSION, CONTRACT_FINGERPRINT)).toBeUndefined();
  });
});
