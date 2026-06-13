// Demo backend that intentionally exhibits many real-world behaviors so Iris can be
// tested against them: auth, 404/500/CORS/wrong-format/wrong-data, eventual consistency,
// a (real-or-mock) LLM call, and a file-scoring endpoint.
import express from 'express';
import cors from 'cors';

const PORT = Number(process.env.API_PORT ?? 8787);
// How long a created item takes to become visible (simulated eventual consistency).
// Real systems might be 30s; default short here so demos/tests don't wait forever.
const REFLECT_MS = Number(process.env.REFLECT_MS ?? 6000);
const LLM_DELAY_MS = Number(process.env.LLM_DELAY_MS ?? 1500);

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const VALID = { email: 'admin@iris.dev', password: 'password' };
const TOKEN = 'iris-demo-token';

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

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  // eslint-disable-next-line no-console -- server startup banner
  console.log(`[iris-api] listening on http://localhost:${PORT} (reflect=${REFLECT_MS}ms)`);
});
