import * as http from 'node:http';
import * as net from 'node:net';
import { LOOPBACK_HOST } from '@syrin/iris-protocol';
import { MCP_SSE_PATH } from './http-server.js';
import { log } from './log.js';

const DEFAULT_DAEMON_READY_TIMEOUT_MS = 10_000;
/**
 * How long to wait for the spawned daemon's port to accept connections before giving up. The default
 * suits a normal machine; a slow CI/VM (heavy headless-browser launch) can raise it via the
 * IRIS_DAEMON_READY_TIMEOUT_MS env var. Invalid/absent values fall back to the default.
 */
const envDaemonReadyTimeoutMs = Number(process.env['IRIS_DAEMON_READY_TIMEOUT_MS']);
const DAEMON_READY_TIMEOUT_MS =
  Number.isFinite(envDaemonReadyTimeoutMs) && envDaemonReadyTimeoutMs > 0
    ? envDaemonReadyTimeoutMs
    : DEFAULT_DAEMON_READY_TIMEOUT_MS;
const DAEMON_POLL_INTERVAL_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns true if something is already listening on the iris port.
 * Uses a plain TCP probe so we don't create a side-effectful SSE session
 * inside the daemon just to check reachability.
 */
export function probeDaemon(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, LOOPBACK_HOST);
  });
}

/** Poll until the daemon's HTTP port accepts connections or the deadline is reached. */
export async function waitForDaemon(port: number): Promise<void> {
  const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const reachable = await probeDaemon(port);
    if (reachable) return;
    await delay(DAEMON_POLL_INTERVAL_MS);
  }
  throw new Error(
    `iris daemon did not become ready on port ${port} within ${DAEMON_READY_TIMEOUT_MS}ms`,
  );
}

function postToSession(url: string, body: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const parsed = new URL(url);
    const bodyBuf = Buffer.from(body, 'utf8');
    const options: http.RequestOptions = {
      host: parsed.hostname,
      port: parsed.port !== '' ? parseInt(parsed.port, 10) : 80,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': bodyBuf.byteLength,
      },
    };
    const req = http.request(options, (res) => {
      res.resume(); // drain so the socket is reused
      resolve();
    });
    req.on('error', (err) => {
      log('iris_mcp_proxy_post_error', { error: err.message });
      resolve();
    });
    req.write(bodyBuf);
    req.end();
  });
}

function buildSessionUrl(rawData: string, port: number): string {
  return rawData.startsWith('/') ? `http://${LOOPBACK_HOST}:${port}${rawData}` : rawData;
}

/**
 * Bridge stdio ↔ SSE: connects to the running daemon's MCP endpoint and forwards
 * Claude Code's stdin/stdout JSON-RPC through it. Never resolves — runs until
 * stdin closes or the SSE stream ends (at which point the process exits so
 * Claude Code restarts the proxy fresh).
 */
export function startMcpProxy(port: number): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    let postUrl: string | null = null;
    const stdinQueue: string[] = [];

    // ── SSE reader ──────────────────────────────────────────────────────────
    const req = http.get({ host: LOOPBACK_HOST, port, path: MCP_SSE_PATH }, (res) => {
      res.setEncoding('utf8');

      let sseBuffer = '';
      let currentEvent = '';
      let currentData = '';

      res.on('data', (chunk: string) => {
        sseBuffer += chunk;
        // Normalise CRLF/CR so the line splitter only needs to handle \n
        const normalised = sseBuffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const lines = normalised.split('\n');
        sseBuffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line === '') {
            // Blank line → dispatch accumulated event
            if (currentData !== '') {
              onSseEvent(currentEvent !== '' ? currentEvent : 'message', currentData, port);
            }
            currentEvent = '';
            currentData = '';
          } else if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const val = line.slice(5).trim();
            currentData = currentData !== '' ? `${currentData}\n${val}` : val;
          }
          // id:/retry:/comment lines are ignored — not needed for the MCP bridge
        }
      });

      res.on('end', () => {
        log('iris_mcp_proxy_sse_ended', { port });
        process.exit(0);
      });

      res.on('error', (err) => {
        log('iris_mcp_proxy_sse_error', { error: err.message });
        process.exit(1);
      });
    });

    req.on('error', (err) => reject(err));

    function onSseEvent(event: string, data: string, p: number): void {
      if (event === 'endpoint') {
        const url = buildSessionUrl(data, p);
        postUrl = url;
        // Flush messages that arrived before the session URL was known
        for (const queued of stdinQueue.splice(0)) {
          void postToSession(url, queued);
        }
        return;
      }
      if (event === 'message') {
        process.stdout.write(`${data}\n`);
      }
    }

    // ── stdin reader ─────────────────────────────────────────────────────────
    process.stdin.setEncoding('utf8');
    let stdinBuffer = '';

    process.stdin.on('data', (chunk: string) => {
      stdinBuffer += chunk;
      const lines = stdinBuffer.split('\n');
      stdinBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        if (postUrl === null) {
          stdinQueue.push(trimmed);
        } else {
          void postToSession(postUrl, trimmed);
        }
      }
    });

    process.stdin.on('end', () => process.exit(0));
  });
}
