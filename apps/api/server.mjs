// Demo backend that intentionally exhibits many real-world behaviors so Reticle can be
// tested against them: auth, 404/500/CORS/wrong-format/wrong-data, eventual consistency,
// a (real-or-mock) LLM call, and a file-scoring endpoint.
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.API_PORT ?? 8787);
// How long a created item takes to become visible (simulated eventual consistency).
// Real systems might be 30s; default short here so demos/tests don't wait forever.
const REFLECT_MS = Number(process.env.REFLECT_MS ?? 6000);
const LLM_DELAY_MS = Number(process.env.LLM_DELAY_MS ?? 1500);

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const VALID = { email: 'admin@reticle.dev', password: 'password' };
const TOKEN = 'reticle-demo-token';

// 1000 seed items + a place for eventually-consistent additions.
const items = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, name: `Item ${i + 1}` }));
let nextId = 1001;

function requireAuth(req, res, next) {
  if (req.headers.authorization === `Bearer ${TOKEN}`) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// --- Auth -----------------------------------------------------------------
app.post('/api/login', (req, res) => {
  const { email, password } = req.body ?? {};
  if (email === VALID.email && password === VALID.password) {
    return res.json({ token: TOKEN, user: { email } });
  }
  return res.status(401).json({ error: 'invalid email or password' });
});

// --- Items: list / eventually-consistent add ------------------------------
app.get('/api/items', requireAuth, (req, res) => {
  const offset = Number(req.query.offset ?? 0);
  const limit = Number(req.query.limit ?? items.length);
  res.json({ items: items.slice(offset, offset + limit), total: items.length });
});

app.post('/api/items', requireAuth, (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (name.length === 0) return res.status(400).json({ error: 'name required' });
  const id = nextId++;
  // Not visible immediately — appears only after REFLECT_MS (needs a refresh to see).
  setTimeout(() => {
    items.push({ id, name });
  }, REFLECT_MS);
  res.status(202).json({ accepted: true, id, name, visibleInMs: REFLECT_MS });
});

// --- Broken endpoints (each a distinct failure mode) ----------------------
app.get('/api/broken/404', (_req, res) => res.status(404).json({ error: 'not found' }));
app.get('/api/broken/500', (_req, res) => res.status(500).json({ error: 'internal server error' }));

app.get('/api/broken/cors', (_req, res) => {
  // Strip the CORS header so a cross-origin browser fetch is blocked.
  res.removeHeader('Access-Control-Allow-Origin');
  res.json({ data: 'you should never read this cross-origin' });
});

app.get('/api/broken/wrong-format', (_req, res) => {
  // Claims/returns HTML where the client expects JSON -> client JSON.parse throws.
  res.type('text/html').send('<!doctype html><html><body>not json</body></html>');
});

app.get('/api/broken/wrong-data', requireAuth, (_req, res) => {
  // 200 OK but the shape is wrong (no `items`) -> client renders nothing / errors.
  res.json({ unexpected: true, oops: 'where are the items' });
});

// --- LLM: generate a script (real if ANTHROPIC_API_KEY, else a delayed mock) ----
app.post('/api/generate-script', requireAuth, async (req, res) => {
  const prompt = String(req.body?.prompt ?? '').trim();
  if (prompt.length === 0) return res.status(400).json({ error: 'prompt required' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          messages: [{ role: 'user', content: `Write a short script for: ${prompt}` }],
        }),
      });
      const data = await r.json();
      const text = data?.content?.[0]?.text ?? '(no content)';
      return res.json({ script: text, source: 'anthropic' });
    } catch (e) {
      return res.status(502).json({ error: `llm call failed: ${String(e)}` });
    }
  }
  await new Promise((r) => setTimeout(r, LLM_DELAY_MS));
  res.json({
    script: `# Generated script for: ${prompt}\nHook: Did you know ${prompt}?\nBeat 1: ...\nCTA: Follow for more.`,
    source: 'mock',
  });
});

// --- File scoring: attach a file, get a score (after a delay) --------------
app.post('/api/score', requireAuth, async (req, res) => {
  const { filename, size } = req.body ?? {};
  if (!filename) return res.status(400).json({ error: 'filename required' });
  await new Promise((r) => setTimeout(r, LLM_DELAY_MS));
  // Deterministic pseudo-score so tests are stable.
  const score = ((String(filename).length * 7 + Number(size ?? 0)) % 100) + 1;
  res.json({ filename, score, verdict: score > 50 ? 'strong' : 'needs work' });
});

// --- streams (§4.7): one SSE build-log and one WebSocket echo ---
// Both accept query flags so the bug injector can ask for a broken variant WITHOUT the client having
// to fake anything: the stream really does stall / really does emit an unparseable frame.
const BUILD_LOG_FRAMES = [
  'fetching source',
  'installing dependencies',
  'compiling',
  'running tests',
  'build complete',
];

app.get('/api/build-log', (req, res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  // silent=1: the connection OPENS and then says nothing. The UI sits on "streaming…" forever, which
  // is the point — the request looks perfectly healthy from the outside.
  if (req.query.silent === '1') return;

  let i = 0;
  const timer = setInterval(() => {
    if (i >= BUILD_LOG_FRAMES.length) {
      clearInterval(timer);
      res.end();
      return;
    }
    // malformed=1: one frame in the middle is not valid JSON, so a client that JSON.parses it drops
    // the frame silently and the log is quietly incomplete.
    const payload =
      req.query.malformed === '1' && i === 2
        ? '{"step": "compiling", oops'
        : JSON.stringify({ step: BUILD_LOG_FRAMES[i], n: i });
    res.write(`data: ${payload}\n\n`);
    i += 1;
  }, 220);
  req.on('close', () => clearInterval(timer));
});

// --- timing (§4.10) support: a search endpoint to debounce against, and an always-failing endpoint
// to retry against. Both exist so the timing bugs are about WHEN the client calls, not about faking.
app.get('/api/search', (req, res) => {
  const q = String(req.query.q ?? '');
  res.json({ q, matches: q.length === 0 ? 0 : (q.length * 3) % 7 });
});

// Always 500s. A correct client retries a bounded number of times with backoff and then gives up;
// an incorrect one hammers it forever, which is only visible as a REQUEST COUNT over time.
app.get('/api/flaky', (_req, res) => res.status(500).json({ error: 'flaky upstream' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// --- Saved-items: server-backed write fixture for response-ignored testing ---------------
//
// This endpoint exists solely to give the response-ignored detector a real server write to
// reason against. Two things make it distinct from every other write in this server:
//
//   1. It is a genuine write (POST that mutates server state) that leaves the browser.
//   2. The response carries a `renderDelayMs` field the client MUST wait before rendering —
//      so the fixture can produce a visible gap between "response landed" and "UI moved".
//
// Query parameters (all optional):
//   ?delay=<ms>   — how long the server itself takes to respond (default: 0)
//   ?broken=1     — respond 200 OK but return no id, causing the client to drop the result
//
// The client controls the render delay via a `?renderDelay=<ms>` parameter of its own; the
// server echoes it back so the e2e harness can use one URL to test both polarities:
//   - renderDelay=0  → correct: UI updates immediately after the response arrives
//   - renderDelay=large → accusable: response lands but the client render trails by > 1 task
const savedItems = [];
let savedItemSeq = 1;

app.get('/api/saved-items', (req, res) => {
  res.json({ items: savedItems });
});

app.post('/api/saved-items', async (req, res) => {
  const delay = Number(req.query.delay ?? 0);
  const broken = req.query.broken === '1';
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  if (broken) {
    // 200 OK but deliberately missing `id` — the client will have nothing to render.
    return res.json({ ok: true });
  }
  const label = String(req.body?.label ?? '').trim();
  if (label.length === 0) return res.status(400).json({ error: 'label required' });
  const id = savedItemSeq++;
  savedItems.push({ id, label, savedAt: new Date().toISOString() });
  return res.json({ id, label, savedAt: savedItems[savedItems.length - 1].savedAt });
});

const server = createServer(app);

// WS echo. `channel` is echoed back so a client can correlate a reply with what it asked for;
// wrongChannel=1 answers on a channel nobody subscribed to, so the reply is silently ignored.
const wss = new WebSocketServer({ server, path: '/ws/echo' });
wss.on('connection', (socket, req) => {
  const wrongChannel =
    new URL(req.url, 'http://localhost').searchParams.get('wrongChannel') === '1';
  socket.on('message', (raw) => {
    let channel = 'deployments';
    try {
      channel = JSON.parse(String(raw)).channel ?? channel;
    } catch {
      /* keep the default channel for an unparseable request */
    }
    socket.send(
      JSON.stringify({ channel: wrongChannel ? 'unrelated' : channel, ok: true, at: 'echo' }),
    );
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console -- server startup banner
  console.log(`[reticle-api] listening on http://localhost:${PORT} (reflect=${REFLECT_MS}ms)`);
});
