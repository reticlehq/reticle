/**
 * The invitation to talk to the people building Reticle: one link, one set of words, every surface.
 *
 * It is always for the HUMAN. The agent's version tells the agent to offer it and never to act on it,
 * because an agent booking calls or handing over an email on somebody's behalf is exactly the kind of
 * outbound instruction a careful evaluator reads as a reason not to install.
 */
import { describe, expect, it } from 'vitest';
import { DISCOVERY_CALL_URL, DISCOVERY_EMAIL_COMMAND, DiscoveryInvite } from './discovery.js';

describe('the discovery invitation', () => {
  it('points at the booking link reticle.sh publishes', () => {
    expect(DISCOVERY_CALL_URL).toBe('https://calendar.app.google/h9NRDbBBQetyTzWM6');
  });

  it('gives the human both ways in: a call, or an email through identify', () => {
    expect(DiscoveryInvite.HUMAN).toContain(DISCOVERY_CALL_URL);
    expect(DiscoveryInvite.HUMAN).toContain(DISCOVERY_EMAIL_COMMAND);
    expect(DISCOVERY_EMAIL_COMMAND).toContain('identify');
    expect(DISCOVERY_EMAIL_COMMAND).toContain('--email');
  });

  it('tells the agent to offer it, and never to book or submit anything itself', () => {
    expect(DiscoveryInvite.AGENT).toContain(DISCOVERY_CALL_URL);
    expect(DiscoveryInvite.AGENT.toLowerCase()).toContain('offer');
    expect(DiscoveryInvite.AGENT.toLowerCase()).toContain('never');
  });
});
