import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Atlas's backend, as a Vite middleware.
 *
 * Deliberately NOT a stub that echoes what it is given. The behaviours below are the ones that make
 * verification hard in real systems, and each exists so a client-side "it worked" can be wrong:
 *
 *  - **Server-authoritative reconciliation.** A dispatch is accepted (202) and then reconciled
 *    asynchronously; some are REVERTED a second later. A 202 is not an outcome.
 *  - **Idempotency keys.** A replayed key returns the FIRST result, so a double-submit looks
 *    successful twice while only one thing happened.
 *  - **Eventual consistency.** A list read immediately after a write can still show the old value;
 *    the write is real, the read is stale.
 *  - **Partial failure.** A bulk action returns 200 with per-item errors inside the body.
 *  - **Push.** Scan events stream over SSE and mutate rows nobody touched.
 *  - **Variable latency.** Every endpoint has its own profile, so orderings differ run to run.
 */

interface Leg {
  id: string;
  from: string;
  to: string;
  status: 'pending' | 'in_transit' | 'arrived' | 'exception';
  etaMinutes: number;
}

interface Shipment {
  id: string;
  ref: string;
  carrier: string;
  origin: string;
  destination: string;
  status: 'draft' | 'dispatched' | 'in_transit' | 'delivered' | 'held';
  weightGrams: number;
  declaredValueMinor: number;
  currency: 'INR' | 'USD' | 'EUR';
  legs: Leg[];
  updatedAt: number;
  version: number;
}

const CARRIERS = ['Bluedart', 'Delhivery', 'DHL', 'FedEx', 'Maersk', 'Ecom'];
const CITIES = ['Mumbai', 'Pune', 'Delhi', 'Chennai', 'Kolkata', 'Hyderabad', 'Surat', 'Kochi'];
const STATUSES: Shipment['status'][] = ['draft', 'dispatched', 'in_transit', 'delivered', 'held'];

/** Deterministic pseudo-random, so a run is reproducible without being uniform. */
function seeded(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296;
    return value / 4294967296;
  };
}

const SHIPMENT_COUNT = 10_000;

function buildShipments(): Shipment[] {
  const rand = seeded(42);
  return Array.from({ length: SHIPMENT_COUNT }, (_v, i): Shipment => {
    const origin = CITIES[Math.floor(rand() * CITIES.length)] ?? 'Mumbai';
    const destination = CITIES[Math.floor(rand() * CITIES.length)] ?? 'Delhi';
    const legCount = 1 + Math.floor(rand() * 3);
    return {
      id: `shp_${String(i).padStart(6, '0')}`,
      ref: `ATL-${String(100000 + i)}`,
      carrier: CARRIERS[Math.floor(rand() * CARRIERS.length)] ?? 'DHL',
      origin,
      destination,
      status: STATUSES[Math.floor(rand() * STATUSES.length)] ?? 'draft',
      weightGrams: Math.floor(200 + rand() * 40_000),
      // Minor units, like every real payments/logistics API. Rendering this as a major-unit figure
      // is a whole bug class, and the client is free to get it wrong.
      declaredValueMinor: Math.floor(10_000 + rand() * 5_000_000),
      currency: (['INR', 'USD', 'EUR'] as const)[Math.floor(rand() * 3)] ?? 'INR',
      legs: Array.from({ length: legCount }, (_l, j): Leg => ({
        id: `leg_${String(i)}_${String(j)}`,
        from: j === 0 ? origin : (CITIES[Math.floor(rand() * CITIES.length)] ?? 'Pune'),
        to:
          j === legCount - 1 ? destination : (CITIES[Math.floor(rand() * CITIES.length)] ?? 'Pune'),
        status: 'pending',
        etaMinutes: Math.floor(30 + rand() * 4000),
      })),
      updatedAt: Date.now() - Math.floor(rand() * 86_400_000),
      version: 1,
    };
  });
}

const shipments = buildShipments();
const byId = new Map(shipments.map((s) => [s.id, s]));

/** Idempotency ledger: key → the response first returned for it. */
const idempotency = new Map<string, unknown>();

/** Dispatches awaiting server-side reconciliation, which may REVERT them. */
const reconciling = new Map<string, { shipmentId: string; at: number }>();

const sseClients = new Set<ServerResponse>();

function pushEvent(event: string, data: unknown): void {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
}

/**
 * Scan events arrive on their own, mutating rows nobody clicked.
 *
 * This is the ambient-churn problem in its real form: the table changes constantly, so "the DOM
 * moved after my action" is not evidence that my action moved it.
 */
const scanPick = seeded(7);

function startScanFeed(): NodeJS.Timeout {
  return setInterval(() => {
    if (sseClients.size === 0) return;
    const target = shipments[Math.floor(scanPick() * 200)];
    if (target === undefined) return;
    target.version += 1;
    target.updatedAt = Date.now();
    pushEvent('scan', { shipmentId: target.id, at: target.updatedAt, version: target.version });
  }, 900);
}

/**
 * Reconciliation: a dispatch accepted a second ago is either confirmed or REVERTED.
 *
 * One in four is reverted. The client already rendered success, so any verdict taken at the moment
 * of the 202 is a guess that happens to be right 75% of the time.
 */
// Deterministic, not random: every fourth reconciliation reverts. Same one-in-four behaviour, but a
// test that drives this path gets the same answer twice — `Math.random()` here made every probe of
// the revert a coin flip, which is not a test.
let reconciled = 0;

function startReconciler(): NodeJS.Timeout {
  return setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of reconciling) {
      if (now - entry.at < 1200) continue;
      reconciling.delete(key);
      const shipment = byId.get(entry.shipmentId);
      if (shipment === undefined) continue;
      reconciled += 1;
      const reverted = reconciled % 4 === 0;
      shipment.status = reverted ? 'held' : 'dispatched';
      shipment.version += 1;
      pushEvent('reconciled', { shipmentId: shipment.id, reverted, status: shipment.status });
    }
  }, 400);
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(payload);
};

const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function atlasApi() {
  return {
    name: 'atlas-mock-api',
    configureServer(server: { middlewares: { use: (fn: unknown) => void } }) {
      // Started HERE, not at module scope. Module-level timers keep the Node process alive, so
      // `vite build` — which imports this config — never exited and the whole repo's build hung.
      // A fixture that cannot be built is not a fixture.
      const timers = [startScanFeed(), startReconciler()];
      for (const timer of timers) timer.unref?.();
      server.middlewares.use(
        async (req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          if (!url.pathname.startsWith('/api/')) {
            next();
            return;
          }

          // ── SSE: scan + reconciliation events ────────────────────────────────────────────────
          if (url.pathname === '/api/events') {
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              connection: 'keep-alive',
            });
            res.write(': connected\n\n');
            sseClients.add(res);
            req.on('close', () => sseClients.delete(res));
            return;
          }

          // ── list: paginated, filterable, and CHUNKED (no content-length) ─────────────────────
          if (url.pathname === '/api/shipments' && req.method === 'GET') {
            const status = url.searchParams.get('status');
            const search = url.searchParams.get('search');
            const page = Number(url.searchParams.get('page') ?? '1');
            const size = Number(url.searchParams.get('size') ?? '50');
            // The slow path is the unfiltered one, so racing two filter clicks lands them out of
            // order — the ordering hazard, produced by latency rather than by a planted flag.
            await sleep(status === null || status === 'all' ? 700 : 90);
            let rows = shipments;
            if (status !== null && status !== 'all') rows = rows.filter((s) => s.status === status);
            if (search !== null && search.length > 0) {
              rows = rows.filter((s) => s.ref.toLowerCase().includes(search.toLowerCase()));
            }
            const start = (page - 1) * size;
            json(res, 200, {
              rows: rows.slice(start, start + size),
              total: rows.length,
              page,
              size,
            });
            return;
          }

          if (url.pathname.startsWith('/api/shipments/') && req.method === 'GET') {
            const id = url.pathname.split('/')[3] ?? '';
            await sleep(120);
            const shipment = byId.get(id);
            if (shipment === undefined) {
              json(res, 404, { error: 'not_found' });
              return;
            }
            json(res, 200, shipment);
            return;
          }

          // ── dispatch: 202 + async reconciliation, with idempotency ───────────────────────────
          if (url.pathname === '/api/dispatch' && req.method === 'POST') {
            const body = await readBody(req);
            const key = String(req.headers['idempotency-key'] ?? '');
            await sleep(180);
            if (key.length > 0 && idempotency.has(key)) {
              // A replay returns the ORIGINAL result. Two submits, two 202s, one dispatch.
              json(res, 202, idempotency.get(key));
              return;
            }
            const id = String(body['shipmentId'] ?? '');
            const shipment = byId.get(id);
            if (shipment === undefined) {
              json(res, 404, { error: 'not_found' });
              return;
            }
            const result = { accepted: true, shipmentId: id, reconcileIn: 1200 };
            if (key.length > 0) idempotency.set(key, result);
            reconciling.set(`${id}:${String(Date.now())}`, { shipmentId: id, at: Date.now() });
            json(res, 202, result);
            return;
          }

          // ── bulk hold: 200 with per-item failures INSIDE the body ────────────────────────────
          if (url.pathname === '/api/bulk-hold' && req.method === 'POST') {
            const body = await readBody(req);
            const ids = Array.isArray(body['ids']) ? (body['ids'] as string[]) : [];
            await sleep(260);
            const results = ids.map((id, i) => {
              const shipment = byId.get(id);
              if (shipment === undefined) return { id, ok: false, error: 'not_found' };
              // Every third one fails validation. The envelope is still 200.
              if (i % 3 === 2) return { id, ok: false, error: 'carrier_locked' };
              shipment.status = 'held';
              shipment.version += 1;
              return { id, ok: true };
            });
            json(res, 200, { results, requested: ids.length });
            return;
          }

          json(res, 404, { error: 'no_route' });
        },
      );
    },
  };
}
