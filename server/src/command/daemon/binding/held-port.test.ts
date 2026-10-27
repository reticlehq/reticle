/**
 * A daemon that holds the port and does not answer (#1937).
 *
 * The field case: a daemon stuck in its exit kept its listening socket open. The kernel queued
 * connections that nothing accepted. When the queue was full, a connect timed out, and the TCP
 * probe read the timeout as "nothing listens". So `reticle status` said the port was free, the MCP
 * proxy said "nothing is listening", and a moment later, when a slot was free, "not a Reticle
 * daemon". Both sentences were false about one process.
 *
 * The child below is that process: it listens with a queue of one, under the daemon's own argv,
 * and SIGSTOP keeps it from accepting.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { LOOPBACK_HOST } from '@reticlehq/core';
import { probeDaemon } from '@/surface/mcp/proxy/proxy-daemon-probe.js';
import { fetchStatus } from './daemon-status-probe.js';
import { osAssignedPort } from './free-port.js';
import { PortPresence, probePresence } from './port-presence.js';
import { DAEMON_INNER_COMMAND, PORT_FLAG } from '@/command/cli/cli-parse.js';
import { captureLookup, describeForeignHolder } from '@/command/cli/ports/port-holder.js';
import { identifyPortHolder } from '../port-state.js';

/** More connects than the queue holds, so the next one cannot be queued. */
const FILLER_CONNECTS = 8;
/** Generous: the probe itself waits its own timeout, and a loaded machine is slower. */
const TEST_TIMEOUT_MS = 20_000;

const LISTENER_SCRIPT =
  "const s=require('net').createServer(()=>{});" +
  's.listen(Number(process.argv[2]),process.argv[3],1,()=>process.stdout.write("up\\n"));';

const children: ChildProcess[] = [];
const sockets: net.Socket[] = [];

afterEach(() => {
  for (const s of sockets.splice(0)) {
    s.destroy();
  }
  for (const c of children.splice(0)) {
    c.kill('SIGKILL');
  }
});

/** A listener under the daemon's argv that accepts nothing, with a full queue. */
async function stoppedDaemonListener(): Promise<{ port: number; pid: number }> {
  const port = await osAssignedPort();
  const child = spawn(
    process.execPath,
    [
      '-e',
      LISTENER_SCRIPT,
      DAEMON_INNER_COMMAND,
      String(port),
      LOOPBACK_HOST,
      PORT_FLAG,
      String(port),
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  children.push(child);
  await new Promise<void>((resolve) => child.stdout?.once('data', () => resolve()));
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error('the listener child has no pid');
  }
  process.kill(pid, 'SIGSTOP');
  for (let i = 0; i < FILLER_CONNECTS; i++) {
    const s = net.connect(port, LOOPBACK_HOST);
    s.on('error', () => undefined);
    sockets.push(s);
  }
  return { port, pid };
}

const posixOnly = 'win32' === process.platform ? it.skip : it;

describe('a port held by a process that does not accept', () => {
  posixOnly(
    'is not read as free',
    async () => {
      const { port } = await stoppedDaemonListener();
      expect(await probeDaemon(port)).toBe(true);
      expect(await probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus })).toBe(
        PortPresence.FOREIGN,
      );
    },
    TEST_TIMEOUT_MS,
  );

  posixOnly(
    'names the holder pid and says it is a Reticle daemon, from its command line',
    async () => {
      const { port, pid } = await stoppedDaemonListener();
      const holder = identifyPortHolder(port, captureLookup);
      if (null === holder) {
        // No `lsof` on this machine: the lookup cannot run, and that case has its own tests.
        return;
      }
      expect(holder.pid).toBe(pid);
      expect(holder.reticleDaemon).toBe(true);
      const msg = describeForeignHolder(port, holder, null);
      expect(msg).toContain(String(pid));
      expect(msg).not.toContain('is not a Reticle daemon');
      expect(msg).toContain('reticle restart');
    },
    TEST_TIMEOUT_MS,
  );
});
