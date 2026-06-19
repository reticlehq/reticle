import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSharedServer, STATUS_PATH, type SharedServer } from './http-server.js';

let shared: SharedServer | undefined;

afterEach(async () => {
  await shared?.close();
  shared = undefined;
});

function listen(server: SharedServer): Promise<number> {
  return new Promise((resolve) => {
    server.httpServer.listen(0, '127.0.0.1', () => {
      const addr = server.httpServer.address() as AddressInfo;
      resolve(addr.port);
    });
  });
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

describe('GET /status', () => {
  it('returns the attached status provider payload as JSON', async () => {
    shared = createSharedServer();
    shared.attachStatus(() => ({
      running: true,
      sessionCount: 1,
      sessions: [{ sessionId: 'demo', url: 'http://localhost:5173', throttled: false }],
    }));
    const port = await listen(shared);
    const res = await get(port, STATUS_PATH);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as { sessionCount: number; sessions: unknown[] };
    expect(parsed.sessionCount).toBe(1);
    expect(parsed.sessions).toHaveLength(1);
  });

  it('falls back to a minimal running body when no status provider is attached', async () => {
    shared = createSharedServer();
    const port = await listen(shared);
    const res = await get(port, STATUS_PATH);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ running: true });
  });
});
