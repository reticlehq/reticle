import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { freePortSafely } from './gate-harness.mjs';

// The full integration setup killed the developer's daemon and its connected MCP clients.
// Exercise real sockets: a port number alone is never permission to terminate its owner.
const children = [];
const sockets = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

async function listener() {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:net';
    const server = createServer(socket => socket.on('error', () => {}));
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const [chunk] = await once(child.stdout, 'data');
  return { child, port: Number(String(chunk).trim()) };
}

describe('port cleanup ownership', () => {
  it('leaves an unrelated listener and its connected client running', async () => {
    const { child, port } = await listener();
    const client = connect(port, '127.0.0.1');
    sockets.push(client);
    await once(client, 'connect');
    await expect(freePortSafely(port)).rejects.toThrow('its owner was left running');
    expect(child.exitCode).toBe(null);
    expect(child.signalCode).toBe(null);
    expect(client.destroyed).toBe(false);
  });

  it('can stop a listener explicitly owned by this run', async () => {
    const { child, port } = await listener();
    const result = await freePortSafely(port, { ownedPids: [child.pid] });
    expect(result.freed).toBe(true);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});
