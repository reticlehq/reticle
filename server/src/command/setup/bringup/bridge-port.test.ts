import { describe, expect, it } from 'vitest';
import { PortPresence } from '@/command/daemon/binding/port-presence.js';
import { bridgeOccupied, freePortAfter } from './bridge-port.js';

/**
 * The bridge is the channel between the daemon and the SDK in the page. While something else holds
 * that port no session can EVER appear, however correct the wiring is — so a run that goes ahead
 * spends its whole budget and then blames the app's instrumentation, which is the wrong place
 * entirely.
 *
 * `serve` already refuses a held port, with prose written for someone starting a daemon. This is the
 * same fact told to someone installing: it has to say what the bridge is, because that is the part
 * that makes "no session appeared" make sense.
 */
describe('init refuses to start over an occupied bridge', () => {
  it('refuses when something that is not a daemon holds the port', () => {
    const refusal = bridgeOccupied(PortPresence.FOREIGN, 59996);
    expect(refusal).toContain('is held by something that is not a Reticle daemon');
    expect(refusal).toContain('59996');
  });

  // Our own daemon on that port is the NORMAL case — that is what init connects to.
  it('says nothing when a Reticle daemon holds it', () => {
    expect(bridgeOccupied(PortPresence.DAEMON, 4400)).toBeUndefined();
  });

  it('says nothing when the port is free', () => {
    expect(bridgeOccupied(PortPresence.FREE, 4400)).toBeUndefined();
  });

  // The refusal has to name the way out as a command to paste, or it is a dead end. `init --port`
  // moves .reticle.json and the page itself, so "set the same port in .reticle.json" was a second,
  // unneeded chore that read as a required one.
  it('names a free port to re-run on', () => {
    const refusal = bridgeOccupied(PortPresence.FOREIGN, 4400, 4401);
    expect(refusal).toContain('reticle init --port 4401');
    expect(refusal).not.toContain('.reticle.json');
  });

  it('still names --port when no free port was found', () => {
    expect(bridgeOccupied(PortPresence.FOREIGN, 4400)).toContain('reticle init --port <n>');
  });
});

describe('a free port near the held one', () => {
  it('skips the ports that answer', async () => {
    const open = new Set([4400, 4401]);
    expect(await freePortAfter(4400, (p) => Promise.resolve(open.has(p)))).toBe(4402);
  });

  it('gives up rather than scanning forever', async () => {
    expect(await freePortAfter(4400, () => Promise.resolve(true))).toBeUndefined();
  });
});
