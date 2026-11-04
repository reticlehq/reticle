/**
 * `reticle doctor` itself must not print the stored attach record as healthy for a held port.
 *
 * The defect this covers is reticlehq/reticle#1710: a daemon whose event loop is suspended
 * still accepts TCP, so its port reads as FOREIGN with `/status` unanswered, while the agent
 * link row still printed the stored record — healthy, or blaming the client. The unit test on
 * the row helper proves the helper picks the pointer; these tests prove `handleDoctor` reaches
 * that branch for a real FOREIGN port and a real stored record.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOOPBACK_HOST } from '@reticlehq/core';
import { describe, expect, it, vi } from 'vitest';
import { STATE_DIR_ENV } from '@/command/daemon/daemon.js';
import {
  rememberEnumerated,
  rememberProxyStarted,
  rememberToolCalled,
} from '@/surface/mcp/attach-memory.js';
import { handleDoctor } from './cli-doctor.js';

const RECORD_HEALTHY =
  '✓ an MCP client attached here and called tools before (a record, not a live check)';

async function holdPort(): Promise<{ server: Server; port: number; sockets: Set<Socket> }> {
  const server = createServer();
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  if (null === address || 'string' === typeof address) {
    throw new Error('TCP port was not assigned');
  }
  return { server, port: address.port, sockets };
}

function close(server: Server, sockets: Set<Socket>): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // The status probe shares a keep-alive agent, so its socket to this black hole stays
    // open after the probe gives up. `close` alone waits for that socket forever; drop it.
    for (const socket of sockets) {
      socket.destroy();
    }
  });
}

function agentLinkLine(output: string): string {
  const line = output.split('\n').find((candidate) => candidate.includes('agent link'));
  expect(line).toBeDefined();
  return line ?? '';
}

async function runDoctor(port: number, stateHome: string): Promise<string> {
  let output = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    output += String(chunk);
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const previousStateHome = process.env[STATE_DIR_ENV];
  try {
    process.env[STATE_DIR_ENV] = stateHome;
    await handleDoctor(port);
    return output;
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    if (undefined === previousStateHome) {
      delete process.env[STATE_DIR_ENV];
    } else {
      process.env[STATE_DIR_ENV] = previousStateHome;
    }
  }
}

describe('handleDoctor agent link row on a FOREIGN port', () => {
  it('a healthy stored record no longer prints as healthy, and no second command appears', async () => {
    const { server, port, sockets } = await holdPort();
    const stateHome = mkdtempSync(join(tmpdir(), 'reticle-doctor-foreign-'));
    try {
      rememberProxyStarted(stateHome, port);
      rememberEnumerated(stateHome, port);
      rememberToolCalled(stateHome, port);
      const output = await runDoctor(port, stateHome);
      const line = agentLinkLine(output);
      expect(line).toContain('follow the daemon row above');
      expect(line).not.toContain('reticle stop');
      expect(line).not.toContain('reticle serve --restart --force');
      expect(output).not.toContain(RECORD_HEALTHY);
    } finally {
      await close(server, sockets);
      rmSync(stateHome, { recursive: true, force: true });
    }
  }, 30000);

  it('an unenumerated stored record no longer prints the restart-client advice', async () => {
    const { server, port, sockets } = await holdPort();
    const stateHome = mkdtempSync(join(tmpdir(), 'reticle-doctor-foreign-'));
    try {
      rememberProxyStarted(stateHome, port);
      const output = await runDoctor(port, stateHome);
      const line = agentLinkLine(output);
      expect(line).toContain('follow the daemon row above');
      expect(line).not.toContain('restart your MCP client');
    } finally {
      await close(server, sockets);
      rmSync(stateHome, { recursive: true, force: true });
    }
  }, 30000);
});
