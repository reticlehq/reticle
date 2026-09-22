import { describe, expect, it, afterEach } from 'vitest';
import { request } from 'node:http';
import { startConnectProxy, type ConnectProxy } from './proxy.js';

let running: ConnectProxy | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

/** A CONNECT, the way every HTTPS client opens a tunnel through a proxy. */
function connect(port: number, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request({ port, method: 'CONNECT', path: target });
    req.on('connect', (_res, socket) => {
      socket.destroy();
      resolve();
    });
    req.on('error', reject);
    req.end();
  });
}

describe('watching which hosts a tool dials', () => {
  /**
   * A CONNECT log and nothing more. No TLS interception, no certificate authority.
   *
   * The trade is deliberate. Intercepting TLS would give `net` at consequence grade -- status
   * codes, response bodies -- and costs a CA the subject has to trust, which is a large thing to
   * ask of somebody verifying their own build tool. A CONNECT log costs nothing, works on every
   * tool that honours the proxy variables, and answers a question nothing else here can:
   * *did it ever call out at all?*
   */
  it('records the host and port a client asked to reach', async () => {
    running = await startConnectProxy({ now: () => 1_000 });
    await connect(running.port, 'api.github.com:443');
    expect(running.connectsSince(0)).toEqual([{ host: 'api.github.com', port: 443, at: 1_000 }]);
  });

  it('reports only what happened after the moment asked about', async () => {
    running = await startConnectProxy({ now: () => 5_000 });
    await connect(running.port, 'example.com:443');
    expect(running.connectsSince(9_000)).toEqual([]);
  });

  /**
   * A port that was not named defaults to 443, which is what a client means by it.
   *
   * Guessing is usually the wrong instinct here, and this is the exception: the CONNECT line IS
   * the client's statement of intent, and a target with no port is a well-defined shorthand
   * rather than something missing.
   */
  it('reads a target with no port as the one an HTTPS client means', async () => {
    running = await startConnectProxy({ now: () => 0 });
    await connect(running.port, 'example.com');
    expect(running.connectsSince(0)[0]?.port).toBe(443);
  });

  /**
   * The environment a subject must be given for any of this to work.
   *
   * Both spellings, upper and lower case, because tools disagree about which they read and a
   * verifier that set only one would silently observe nothing while looking like it was watching.
   */
  it('names the environment a subject needs, in both spellings tools read', async () => {
    running = await startConnectProxy({ now: () => 0 });
    const env = running.env();
    expect(env['HTTPS_PROXY']).toBe(`http://127.0.0.1:${String(running.port)}`);
    expect(env['https_proxy']).toBe(env['HTTPS_PROXY']);
    expect(env['HTTP_PROXY']).toBe(env['HTTPS_PROXY']);
  });
});

describe('a real process dialling through it', () => {
  /**
   * End to end: a child given the proxy variables, dialling a host, seen by the proxy.
   *
   * The unit tests above prove the proxy records a CONNECT. This proves the PLUMBING -- that a
   * subject handed `env()` actually routes through it -- which is the half that silently fails.
   * A verifier whose environment did not reach the subject would declare a `net` channel,
   * observe nothing forever, and look exactly like a tool that never calls out.
   *
   * Uses a client that honours the variables explicitly rather than trusting Node's fetch to,
   * because what is under test here is the proxy and not undici's proxy support.
   */
  it('sees a host dialled by a separate process it was given the environment for', async () => {
    running = await startConnectProxy({ now: () => Date.now() });
    const { NodeSupervisor } = await import('../process/node-supervisor.js');
    const supervisor = new NodeSupervisor({
      executable: process.execPath,
      workspaceRoot: process.cwd(),
      tool: { id: 'dialler', version: '1', workspace: 'ws' },
      now: () => Date.now(),
      env: { ...process.env, ...running.env() },
    });
    await supervisor.run(
      'dial',
      [
        '-e',
        // A CONNECT straight at whatever HTTPS_PROXY names, which is what every client that
        // honours the variable ends up doing.
        `const u = new URL(process.env.HTTPS_PROXY);
         const r = require('node:http').request({ host: u.hostname, port: u.port, method: 'CONNECT', path: 'example.invalid:443' });
         r.on('connect', (_x, s) => { s.destroy(); process.exit(0); });
         r.on('error', () => process.exit(0));
         r.end();`,
      ],
      10_000,
    );
    expect(running.connectsSince(0).map((c) => c.host)).toContain('example.invalid');
  });
});
