import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReticleEnv, MCP_SSE_PATH } from '@reticlehq/core';
import { removeTempDir } from './machine/temp-dir.js';
import { startDaemon, type RunningServer } from './index.js';
import { FakeBrowser, waitUntil } from './portal/bridge/bridge.test-harness.js';

/**
 * Regression for #1138: a live browser session is stronger evidence that an app has connected than
 * the durable "connected before" memory, which can be empty or stale for a project the plugin wired
 * without writing `.reticle.json` (see connection-memory.ts's KNOWN LIMIT). Before the fix, the MCP
 * `initialize` instructions asked ONLY the durable memory, so a session that is live *right now* was
 * still told "no app has ever connected" and led with the first-install steps (`init`, restart,
 * load) — reported from the field as an agent redundantly (and, with a human at the keyboard,
 * destructively) restarting a dev server that was fine.
 */

interface SseFrame {
  event: string;
  data: string;
}

function openSse(port: number): Promise<{
  waitFor: (match: (f: SseFrame) => boolean, timeoutMs?: number) => Promise<SseFrame>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: MCP_SSE_PATH, agent: false }, (res) => {
      const frames: SseFrame[] = [];
      const waiters: { match: (f: SseFrame) => boolean; resolve: (f: SseFrame) => void }[] = [];
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          let event = 'message';
          const data: string[] = [];
          for (const line of part.split('\n')) {
            if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
            else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trim());
          }
          const frame: SseFrame = { event, data: data.join('\n') };
          frames.push(frame);
          for (let i = waiters.length - 1; i >= 0; i -= 1) {
            const waiter = waiters[i];
            if (waiter !== undefined && waiter.match(frame)) {
              waiter.resolve(frame);
              waiters.splice(i, 1);
            }
          }
        }
      });
      resolve({
        waitFor: (match, timeoutMs = 5000) =>
          new Promise<SseFrame>((settle, fail) => {
            const already = frames.find(match);
            if (already !== undefined) {
              settle(already);
              return;
            }
            const timer = setTimeout(
              () => fail(new Error('no SSE frame matched within the budget')),
              timeoutMs,
            );
            waiters.push({
              match,
              resolve: (f) => {
                clearTimeout(timer);
                settle(f);
              },
            });
          }),
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
  });
}

function post(port: number, path: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const rpc = (id: number, method: string, params?: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

function idOf(frame: SseFrame): number | undefined {
  try {
    const id = (JSON.parse(frame.data) as { id?: unknown }).id;
    return 'number' === typeof id ? id : undefined;
  } catch {
    return undefined;
  }
}

describe('the initialize instructions when a session is live but durable memory is empty', () => {
  let server: RunningServer | undefined;
  let dir: string | undefined;
  let savedStateDir: string | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (dir !== undefined) await removeTempDir(dir);
    dir = undefined;
    if (savedStateDir === undefined) delete process.env[ReticleEnv.STATE_DIR];
    else process.env[ReticleEnv.STATE_DIR] = savedStateDir;
    savedStateDir = undefined;
  });

  it('does not lead with the first-install steps once a browser session is connected', async () => {
    savedStateDir = process.env[ReticleEnv.STATE_DIR];
    dir = await mkdtemp(join(tmpdir(), 'reticle-mcp-live-session-'));
    // An empty, freshly-made state directory: `hasAnyProjectConnectedBefore` has nothing to find here,
    // which is the "durable memory says no" half of the bug.
    process.env[ReticleEnv.STATE_DIR] = join(dir, 'state');
    const root = join(dir, '.reticle');

    server = await startDaemon({
      port: 0,
      reticleRoot: root,
      pairingTokenDir: join(dir, 'token'),
      token: 'pair-me',
      now: () => 1_700_000_000_000,
    });
    const port = await server.bridge.ready;

    // The "live session" half: a browser is connected RIGHT NOW, which the durable memory alone
    // cannot see.
    const browser = new FakeBrowser(port, 'sess-live', false, 'pair-me');
    await browser.open();
    await waitUntil(() => 1 === server?.bridge.sessions.count());

    const sse = await openSse(port);
    const endpoint = await sse.waitFor((f) => 'endpoint' === f.event);
    await post(
      port,
      endpoint.data,
      rpc(1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0' },
      }),
    );
    const reply = await sse.waitFor((f) => 1 === idOf(f));
    const instructions =
      (JSON.parse(reply.data) as { result?: { instructions?: string } }).result?.instructions ?? '';

    expect(
      instructions,
      'a live session is stronger evidence than empty durable memory, but the handshake still opened with the first-install steps',
    ).not.toContain('no app has ever connected');
    expect(instructions.startsWith('FIRST:')).toBe(false);

    sse.close();
    browser.close();
  });
});
