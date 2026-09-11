// A TCP proxy that breaks connections in NAMED ways, so a transport fault is specified rather than
// approximated.
//
// The battery induces transport faults with SIGKILL. That is one blunt instrument standing in for
// several distinct failures, and it cannot express most of them: a peer that RESETS mid-response, a
// listener that accepts and never serves, a link that goes slow rather than away, a response cut
// off half-sent. Those are the shapes the proxy's three unanswered-call populations actually exist
// to handle, and none of them is a `kill -9`.
//
// It is also how I twice reached a WRONG conclusion about MCP stability. `lsof -ti tcp:4400 | xargs
// kill -9` takes the MCP proxy along with the daemon, so "the link never recovers" was measured
// twice and was my own kill both times. A named toxic cannot make that mistake: it breaks the
// connection, never the process.
//
// Toxiproxy is the standard tool here and would be a fine dependency. It is not installed on this
// machine and the battery is deliberately dependency-free, so this is the small substitute: five
// behaviours over node:net, no install step, and nothing to keep in sync with a service.
//
// Self-check: `node apps/e2e/fault-proxy.mjs --self-check`
import net from 'node:net';

/** What the link does. Named, because "the daemon died" is not a description of a network fault. */
export const Fault = {
  /** Forward everything. The control — without it, every assertion below could pass on a broken proxy. */
  NONE: 'none',
  /** Destroy each connection with an RST as soon as it is made. `ECONNRESET` at the client. */
  RESET_PEER: 'reset-peer',
  /** Accept and never forward a byte. The shape a wedged daemon or a foreign squatter presents. */
  BLACKHOLE: 'blackhole',
  /** Forward, but hold each chunk. Slow, not gone — the case a liveness probe passes and a call does not. */
  LATENCY: 'latency',
  /** Forward `limitBytes` and then destroy. A response cut off half-sent. */
  TRUNCATE: 'truncate',
};

/**
 * Start a proxy on `listenPort` that forwards to `targetPort` and can be told to misbehave.
 *
 * The fault is read PER CHUNK rather than captured at connect, so a test can break an established
 * link mid-call — which is the interesting case and the one a connect-time decision cannot reach.
 */
export function startFaultProxy({ listenPort, targetPort, host = '127.0.0.1' }) {
  let fault = Fault.NONE;
  let latencyMs = 250;
  let limitBytes = 64;
  const sockets = new Set();

  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('error', () => {});
    client.on('close', () => sockets.delete(client));

    if (fault === Fault.RESET_PEER) {
      client.resetAndDestroy();
      return;
    }
    if (fault === Fault.BLACKHOLE) {
      // Accepted and then ignored. No upstream connection is opened at all.
      return;
    }

    const upstream = net.connect(targetPort, host);
    sockets.add(upstream);
    upstream.on('error', () => client.destroy());
    upstream.on('close', () => {
      sockets.delete(upstream);
      client.destroy();
    });

    let forwarded = 0;
    const pump = (from, to) => {
      from.on('data', (chunk) => {
        if (fault === Fault.RESET_PEER) {
          from.resetAndDestroy();
          to.resetAndDestroy();
          return;
        }
        if (fault === Fault.TRUNCATE) {
          forwarded += chunk.length;
          if (forwarded > limitBytes) {
            to.destroy();
            from.destroy();
            return;
          }
        }
        if (fault === Fault.LATENCY) {
          setTimeout(() => {
            if (!to.destroyed) to.write(chunk);
          }, latencyMs).unref();
          return;
        }
        if (!to.destroyed) to.write(chunk);
      });
    };
    pump(client, upstream);
    pump(upstream, client);
  });

  const ready = new Promise((resolve) => server.listen(listenPort, host, resolve));

  return {
    ready,
    /** Change the fault. Applies to new chunks on EXISTING connections, not just new ones. */
    set(next, opts = {}) {
      fault = next;
      if (opts.latencyMs !== undefined) latencyMs = opts.latencyMs;
      if (opts.limitBytes !== undefined) limitBytes = opts.limitBytes;
    },
    /** Cut every live connection without changing the fault — a clean "the link dropped". */
    cutAll() {
      for (const s of sockets) s.destroy();
      sockets.clear();
    },
    get fault() {
      return fault;
    },
    async stop() {
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ── self-check ────────────────────────────────────────────────────────────────────────────────
// Each fault must actually produce its own distinct observable. A fault proxy whose toxics all look
// the same is worse than no fault proxy: every assertion downstream would pass for the wrong reason.
async function selfCheck() {
  const assert = await import('node:assert/strict');
  const ORIGIN = 45_301;
  const PROXY = 45_302;

  const origin = net.createServer((s) => {
    s.on('data', () => s.write('x'.repeat(512)));
    s.on('error', () => {});
  });
  await new Promise((r) => origin.listen(ORIGIN, '127.0.0.1', r));

  const proxy = startFaultProxy({ listenPort: PROXY, targetPort: ORIGIN });
  await proxy.ready;

  const attempt = (timeoutMs = 1_500) =>
    new Promise((resolve) => {
      let bytes = 0;
      const c = net.connect(PROXY, '127.0.0.1', () => c.write('ping'));
      const done = (outcome) => {
        c.destroy();
        resolve({ outcome, bytes });
      };
      c.on('data', (d) => {
        bytes += d.length;
      });
      c.on('error', (e) => done(e.code === 'ECONNRESET' ? 'reset' : 'error'));
      c.on('close', () => resolve({ outcome: bytes > 0 ? 'data' : 'closed', bytes }));
      setTimeout(() => done(bytes > 0 ? 'data' : 'silent'), timeoutMs).unref();
    });

  proxy.set(Fault.NONE);
  const clean = await attempt();
  assert.equal(
    clean.outcome,
    'data',
    'the control must forward — otherwise nothing below means anything',
  );
  assert.ok(clean.bytes >= 512, `expected the full response, got ${String(clean.bytes)}`);

  proxy.set(Fault.RESET_PEER);
  const reset = await attempt();
  assert.ok(['reset', 'closed'].includes(reset.outcome), `reset-peer gave ${reset.outcome}`);
  assert.equal(reset.bytes, 0, 'a reset connection must not deliver a payload');

  proxy.set(Fault.BLACKHOLE);
  const black = await attempt(600);
  assert.equal(black.outcome, 'silent', `blackhole gave ${black.outcome}`);

  proxy.set(Fault.TRUNCATE, { limitBytes: 64 });
  const cut = await attempt();
  assert.ok(cut.bytes < 512, `truncate delivered the whole body (${String(cut.bytes)} bytes)`);

  proxy.set(Fault.LATENCY, { latencyMs: 120 });
  const slow = await attempt();
  assert.equal(slow.outcome, 'data', 'latency must still DELIVER — slow is not gone');

  await proxy.stop();
  await new Promise((r) => origin.close(r));
  console.log(
    'fault-proxy self-check: ok (none/reset/blackhole/truncate/latency are distinguishable)',
  );
}

if (process.argv.includes('--self-check')) {
  await selfCheck();
}
