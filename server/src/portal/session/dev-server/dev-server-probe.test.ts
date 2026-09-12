/**
 * The scan claimed "nothing is listening on the ports Reticle scans" at a user whose Nuxt dev server
 * was listening on one of them.
 *
 * The server was started with `--host`, so it bound `0.0.0.0` and `[::]` rather than the loopback
 * addresses. A listener on `0.0.0.0:<port>` serves `localhost:<port>` and MUST count as found — but
 * a single-name probe resolves `localhost` to whichever family the OS prefers (on Windows, `::1`),
 * and a v4-wildcard listener does not accept there. The claim was reported as a fact, which is what
 * made it expensive: an absence stated as evidence sends the reader to the wrong half of the system.
 *
 * So the probe asks BOTH families and takes either answer.
 */

import { describe, expect, it } from 'vitest';
import { PROBE_HOSTS, anyFamilyServes, probeDevServers } from './dev-server-probe.js';

describe('the probe asks both address families', () => {
  it('covers the IPv4 and IPv6 loopbacks by address, not by a name the OS resolves for us', () => {
    expect(PROBE_HOSTS).toContain('127.0.0.1');
    expect(PROBE_HOSTS).toContain('::1');
  });

  it('counts a port as up when only the IPv4 loopback answers (a `0.0.0.0` wildcard bind)', async () => {
    const seen: string[] = [];
    const up = await anyFamilyServes(3000, (_port, host) => {
      seen.push(host);
      return Promise.resolve('127.0.0.1' === host);
    });
    expect(up).toBe(true);
    expect(seen).toContain('::1');
  });

  it('counts a port as up when only the IPv6 loopback answers (a `[::]` wildcard bind)', async () => {
    const up = await anyFamilyServes(3000, (_port, host) => Promise.resolve('::1' === host));
    expect(up).toBe(true);
  });

  it('is still absent when neither family answers', async () => {
    expect(await anyFamilyServes(3000, () => Promise.resolve(false))).toBe(false);
  });

  it('never rejects when a family probe throws', async () => {
    const up = await anyFamilyServes(3000, (_port, host) =>
      '::1' === host ? Promise.reject(new Error('EAFNOSUPPORT')) : Promise.resolve(true),
    );
    expect(up).toBe(true);
  });

  it('reports the listening ports in ascending order', async () => {
    const ports = await probeDevServers([8080, 3000, 5173], (p) => Promise.resolve(p !== 5173));
    expect(ports).toEqual([3000, 8080]);
  });
});

/**
 * A dev server that is RUNNING but slow to answer must not be reported as absent.
 *
 * The probe asks for a document and treats anything that does not arrive inside 400ms as nothing at
 * all, which conflates two states that call for opposite next actions. That budget is right for Vite
 * handing back a static index.html and wrong for any SSR framework compiling a route on the first
 * request — Nuxt and Next routinely take seconds cold.
 *
 * Reported from the field on Nuxt 4: the dev server was serving 57KB of HTML on port 5000, the
 * reporter proved it answered on 127.0.0.1, ::1 and localhost, and every Reticle diagnostic said
 * "nothing is listening on the ports Reticle scans" and told them to start a server that was already
 * running. A second `nuxt dev` would have hit the dev lock.
 *
 * The fix is a third state rather than a longer timeout, because a longer timeout would re-open the
 * false positive this check exists to close: macOS AirPlay Receiver holds port 5000 on every Mac and
 * ANSWERS, promptly, with 403 — so it is still rejected on content, not on speed. Something that
 * accepts a connection and then says nothing is a listener we cannot classify, and saying so is
 * honest where "nothing is there" is a lie.
 */
describe('a listener that is slow is not a listener that is absent', () => {
  it('reports a port that connects but never answers as UNCLASSIFIED, not absent', async () => {
    const { classifyPort, PortState } = await import('./dev-server-probe.js');
    const state = await classifyPort(5000, () => Promise.resolve(PortState.CONNECTED_NO_ANSWER));
    expect(state).toBe(PortState.CONNECTED_NO_ANSWER);
    expect(state).not.toBe(PortState.CLOSED);
  });

  it('still rejects a thing that answers promptly with a refusal (the AirPlay case)', async () => {
    const { classifyPort, PortState } = await import('./dev-server-probe.js');
    expect(await classifyPort(5000, () => Promise.resolve(PortState.CLOSED))).toBe(
      PortState.CLOSED,
    );
  });

  it('probeDevServers still returns only ports serving a document', async () => {
    const { probeDevServers } = await import('./dev-server-probe.js');
    const found = await probeDevServers([3000, 5000], (p) => Promise.resolve(3000 === p));
    expect(found).toEqual([3000]);
  });
});
