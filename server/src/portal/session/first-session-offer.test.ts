/**
 * The first-session offer, said once on the first tool call of each agent connection.
 *
 * The plugin's SessionStart hook runs only when a session starts. A plugin installed in an open
 * session and loaded with `/reload-plugins` never runs it, so the person never got the offer. The
 * MCP server sees the first call of every connection, so it says the offer there too.
 */
import { describe, expect, it } from 'vitest';
import { firstSessionOffer } from './no-session-next-action.js';
import { firstSessionOfferGate } from './zero-install-first-call.js';

const APP = '/work/shop';

function gate(over: { project?: string | undefined; connected?: boolean } = {}): {
  offer: (attachId: string) => string | undefined;
  offered: string[];
} {
  const offered: string[] = [];
  const project = 'project' in over ? over.project : APP;
  const offer = firstSessionOfferGate({
    project: () => project,
    connected: () => true === over.connected,
    offered: (dir) => {
      offered.push(dir);
    },
  });
  return { offer, offered };
}

describe('the first-session offer on a connection', () => {
  it('says the offer on the first call when no app is attached, and never again', () => {
    const { offer, offered } = gate();
    const text = offer('attach-1');
    expect(text).toBe(firstSessionOffer('npx @reticlehq/server init'));
    expect(text).toContain('reticle_lease');
    expect(text).toContain('Ask the user before you wire the app');
    expect(offer('attach-1')).toBeUndefined();
    expect(offered).toEqual([APP]);
  });

  it('says nothing in a project that is already wired, or that is not a web app', () => {
    expect(gate({ project: undefined }).offer('attach-1')).toBeUndefined();
  });

  it('says nothing when an app is attached', () => {
    expect(gate({ connected: true }).offer('attach-1')).toBeUndefined();
  });

  it('gives each connection its own once', () => {
    const { offer } = gate();
    expect(offer('attach-1')).toBeDefined();
    expect(offer('attach-2')).toBeDefined();
    expect(offer('attach-2')).toBeUndefined();
  });

  it('looks only at the first call: a later call with no app says nothing', () => {
    let connected = true;
    const offer = firstSessionOfferGate({
      project: () => APP,
      connected: () => connected,
      offered: () => undefined,
    });
    expect(offer('attach-1')).toBeUndefined();
    connected = false;
    expect(offer('attach-1')).toBeUndefined();
  });
});
