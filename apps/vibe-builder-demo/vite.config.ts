import { defineConfig } from 'vite';
import type { Connect } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — plain .mjs sibling, no types; runs in the Vite (Node) process.
import { createBuilderApi } from './qa/builder-api.mjs';

/**
 * The "generated app" preview for this app-builder demo: an Expense Tracker plus a tiny in-process
 * API, served from one Vite dev server (the analogue of a builder's preview pod). The frontend is
 * instrumented with the Reticle SDK (see src/main.ts) so a QA agent can observe real DOM/network/console/
 * state — not pixels. Bug class is chosen per-request via the `?bug=` URL param (the page forwards it
 * as an `x-bug` header), so ONE running preview serves all six silent-failure classes.
 */

const BUG_MODES = [
  'none',
  'mock-data', // POST 200 but never persists
  'dead-delete', // DELETE 200 but never removes
  'no-validation', // "abc" accepted as an amount (stores NaN)
] as const;

interface Expense {
  id: number;
  amount: number;
  category: string;
  note: string;
}

/** The bridge port the page's SDK should dial. Injected so the QA harness can pick a free port. */
const BRIDGE_PORT = process.env['RETICLE_PREVIEW_BRIDGE_PORT'] ?? '4400';

/**
 * The bridge REQUIRES the daemon's auto-provisioned pairing token on the websocket hello, even on
 * loopback — that is what closes the "any local origin is trusted" gap. This demo wires its SDK by
 * hand, so nothing was supplying it and every connect failed `authentication_failed` in a silent
 * reconnect loop: no session, and each QA step then reported the app as unverifiable. Served through
 * the config endpoint the page already fetches, rather than inlined at build time, because the
 * harness starts its own bridge after this config is read.
 */
function pairingToken(): string {
  const fromEnv = process.env['RETICLE_TOKEN'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const dir = process.env['RETICLE_PAIRING_TOKEN_DIR'] ?? join(homedir(), '.reticle');
  try {
    return readFileSync(join(dir, 'pairing-token'), 'utf8').trim();
  } catch {
    return ''; // a tokenless bridge accepts the empty case
  }
}

function readBug(req: IncomingMessage): string {
  const header = req.headers['x-bug'];
  const value = Array.isArray(header) ? header[0] : header;
  return value !== undefined && (BUG_MODES as readonly string[]).includes(value) ? value : 'none';
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

/** Server-side bug classes live here; client-side ones (double-submit, wrong-total, console-error)
 * live in src/main.ts. State is in-memory and reset via DELETE /api/reset before each run. */
function apiMiddleware(): Connect.NextHandleFunction {
  let expenses: Expense[] = [];
  let nextId = 1;
  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return next();
    const bug = readBug(req);

    if (req.method === 'GET' && url.pathname === '/api/reticle-config') {
      // The page asks where its local bridge lives — avoids build-time port injection.
      return send(res, 200, { bridgePort: Number(BRIDGE_PORT), token: pairingToken() });
    }
    if (req.method === 'DELETE' && url.pathname === '/api/reset') {
      expenses = [];
      nextId = 1;
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/expenses') {
      return send(res, 200, { expenses });
    }
    if (req.method === 'POST' && url.pathname === '/api/expenses') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw || '{}') as Record<string, unknown>;
        } catch {
          return send(res, 400, { error: 'invalid json' });
        }
        const amountNum = Number(body['amount']);
        if (
          bug !== 'no-validation' &&
          (body['amount'] === '' || body['amount'] === undefined || Number.isNaN(amountNum))
        ) {
          return send(res, 422, { error: 'amount must be a number' });
        }
        const expense: Expense = {
          id: nextId++,
          amount: amountNum,
          category: typeof body['category'] === 'string' ? body['category'] : 'other',
          note: typeof body['note'] === 'string' ? body['note'] : '',
        };
        // BUG mock-data: report success but never persist (the #1 generated-app complaint).
        if (bug !== 'mock-data') expenses.push(expense);
        return send(res, 200, { expense });
      });
      return undefined;
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/expenses/')) {
      const id = Number(url.pathname.split('/').pop());
      // BUG dead-delete: 200 but never removes (server↔UI desync after refresh).
      if (bug !== 'dead-delete') expenses = expenses.filter((e) => e.id !== id);
      return send(res, 200, { ok: true });
    }
    // Not a preview route — let the next middleware (the Builder API) handle it.
    return next();
  };
}

export default defineConfig({
  server: { port: Number(process.env['RETICLE_PREVIEW_PORT'] ?? 4310) },
  // Both pages, named explicitly. Vite's default single `index.html` input silently dropped
  // builder.html — the OUTER self-test app — from every build, so src/builder-ui.ts was unreachable
  // from the build graph while working fine under `vite dev`, which serves any HTML on disk.
  build: { rollupOptions: { input: ['index.html', 'builder.html'] } },
  plugins: [
    {
      name: 'vibe-builder-preview-api',
      configureServer(server) {
        server.middlewares.use(apiMiddleware());
        // The Builder builder API (verify/repair) — the INNER Reticle layer, same origin as the UI.
        server.middlewares.use(
          createBuilderApi({
            previewUrl: `http://localhost:${String(process.env['RETICLE_PREVIEW_PORT'] ?? 4310)}`,
            bridgePort: Number(process.env['RETICLE_PREVIEW_BRIDGE_PORT'] ?? 4400),
          }),
        );
      },
    },
  ],
});
