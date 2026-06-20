/**
 * The thin node:http adapter for the verify endpoint. It reads the request body, delegates to the
 * PURE handleVerifyRequest (all routing/guard/verdict logic lives there), and writes the JSON
 * response. Bound to localhost by design; a token adds defence in depth. Keeping this layer dumb means
 * the tested logic is the pure handler — this file is just wire plumbing.
 */

import * as http from 'node:http';
import type { IrisVerificationRun } from '@syrin/iris-protocol';
import type { IrisRunner } from './iris-runner.js';
import { handleVerifyRequest, type VerifyHttpRequest } from './verify-http.js';

const LOCALHOST = '127.0.0.1';
const MAX_BODY_BYTES = 1_000_000;
/** Partner pipelines send the token here (localhost-bound, so this is defence-in-depth, not the wall). */
export const TOKEN_HEADER = 'x-iris-token';
const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export interface VerifyServerOptions {
  runner: IrisRunner;
  /** Empty string ⇒ no token required (localhost-only). */
  token: string;
  /** Optional persist hook — the live wiring passes RunStore.write so every verdict is saved. */
  persist?: (run: IrisVerificationRun) => Promise<void>;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Build the request listener. Reads + size-caps the body, then hands off to the pure handler. */
export function createVerifyRequestListener(opts: VerifyServerOptions): http.RequestListener {
  return (req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        res.writeHead(413, JSON_HEADERS);
        res.end(JSON.stringify({ error: 'request too large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (tooLarge) return;
      void writeResponse(req, res, opts, Buffer.concat(chunks).toString('utf8'));
    });
  };
}

async function writeResponse(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: VerifyServerOptions,
  raw: string,
): Promise<void> {
  let body: unknown = {};
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, JSON_HEADERS);
      res.end(JSON.stringify({ error: 'invalid json' }));
      return;
    }
  }

  const token = singleHeader(req.headers[TOKEN_HEADER]);
  const request: VerifyHttpRequest = {
    method: req.method ?? 'GET',
    path: (req.url ?? '/').split('?')[0] ?? '/',
    body,
    ...(token !== undefined ? { token } : {}),
  };

  const result = await handleVerifyRequest(request, opts.runner, opts.token, opts.persist);
  res.writeHead(result.status, JSON_HEADERS);
  res.end(JSON.stringify(result.body));
}

/** Start the verify server on localhost. Resolves once listening; returns the bound server + port. */
export function startVerifyServer(
  opts: VerifyServerOptions,
  port: number,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(createVerifyRequestListener(opts));
  return new Promise((resolve) => {
    server.listen(port, LOCALHOST, () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : port;
      resolve({ server, port: boundPort });
    });
  });
}
