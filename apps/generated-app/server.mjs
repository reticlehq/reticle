#!/usr/bin/env node
/**
 * A self-contained "generated app" — a full-stack Expense Tracker that mirrors what an AI app-builder
 * (Emergent-style) emits: a React-ish frontend + a JSON API + a data store, served end to end from one
 * process. Its whole purpose is to be VERIFIED: set BUG_MODE to seed exactly the silent-failure classes
 * vibe-coded apps ship with, then point Iris at it and watch the verdict catch them.
 *
 *   node apps/generated-app/server.mjs                 # everything works (BUG_MODE=none)
 *   BUG_MODE=mock-data node apps/generated-app/server.mjs    # POST "succeeds" but nothing persists
 *   BUG_MODE=dead-delete ...     # DELETE returns 200 but never removes (state desync)
 *   BUG_MODE=double-submit ...   # the Add button fires POST twice
 *   BUG_MODE=no-validation ...   # "abc" is accepted as an amount (stores NaN)
 *   BUG_MODE=wrong-total ...     # the Total lies (UI ≠ data)
 *   BUG_MODE=console-error ...   # an action logs a console.error, UI still renders
 *
 * No build step, no deps — Node only. See README.md for the Iris verification walkthrough.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.GENAPP_PORT ?? 4500);
const BUG = process.env.BUG_MODE ?? 'none';

/** In-memory "database". A real generated app would use Postgres/SQLite; the bug classes are identical. */
let expenses = [];
let nextId = 1;

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

function handleApi(req, res, url) {
  // GET /api/expenses — the list (source of truth)
  if (req.method === 'GET' && url.pathname === '/api/expenses') {
    return json(res, 200, { expenses });
  }

  // POST /api/expenses — create
  if (req.method === 'POST' && url.pathname === '/api/expenses') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return json(res, 400, { error: 'invalid json' });
      }
      const amountNum = Number(body.amount);
      // BUG: no-validation accepts non-numeric / empty amounts (stores NaN).
      if (
        BUG !== 'no-validation' &&
        (body.amount === '' || body.amount === undefined || Number.isNaN(amountNum))
      ) {
        return json(res, 422, { error: 'amount must be a number' });
      }
      const expense = {
        id: nextId++,
        amount: amountNum,
        category: body.category ?? 'other',
        note: body.note ?? '',
      };
      // BUG: mock-data returns success but never persists (the #1 generated-app complaint).
      if (BUG !== 'mock-data') expenses.push(expense);
      return json(res, 200, { expense });
    });
    return undefined;
  }

  // DELETE /api/expenses/:id
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/expenses/')) {
    const id = Number(url.pathname.split('/').pop());
    // BUG: dead-delete returns 200 but never removes (server↔UI desync after refresh).
    if (BUG !== 'dead-delete') expenses = expenses.filter((e) => e.id !== id);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, bug: BUG });
  }
  return json(res, 404, { error: 'not found' });
}

const PAGE = (bug) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Expense Tracker</title>
<style>body{font-family:system-ui;margin:2rem;max-width:640px}input,select,button{padding:.4rem;margin:.2rem}
li{display:flex;justify-content:space-between;border-bottom:1px solid #eee;padding:.3rem 0}</style></head>
<body>
<h1>Expense Tracker</h1>
<form id="add">
  <input id="amount" placeholder="amount" data-testid="amount"/>
  <select id="category" data-testid="category"><option>food</option><option>travel</option><option>other</option></select>
  <input id="note" placeholder="note" data-testid="note"/>
  <button type="submit" data-testid="add">Add</button>
  <span id="err" style="color:#c00"></span>
</form>
<h2>Total: <span id="total" data-testid="total">0</span></h2>
<ul id="list" data-testid="list"></ul>
<script>
const BUG = ${JSON.stringify(bug)};
// A minimal store an instrumented build would expose to Iris (window.__app for state-truth checks).
const store = { expenses: [], get total(){ return this.expenses.reduce((s,e)=>s+(e.amount||0),0); } };
window.__app = store;
const $ = (id) => document.getElementById(id);
async function load(){
  const r = await fetch('/api/expenses'); const { expenses } = await r.json();
  store.expenses = expenses; render();
}
function render(){
  $('list').innerHTML = store.expenses.map(e =>
    '<li>'+e.category+' — '+e.amount+' <button data-id="'+e.id+'" data-testid="del">x</button></li>').join('');
  // BUG: wrong-total adds 1 so the displayed Total lies vs the data.
  $('total').textContent = String(store.total + (BUG==='wrong-total'?1:0));
}
$('add').addEventListener('submit', async (ev) => {
  ev.preventDefault(); $('err').textContent='';
  const amount = $('amount').value;
  // (client validation intentionally absent — the server is the gate; no-validation exposes it)
  const payload = { amount, category:$('category').value, note:$('note').value };
  const post = () => fetch('/api/expenses', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  const res = await post();
  // BUG: double-submit fires the same POST twice.
  if (BUG==='double-submit') await post();
  if (!res.ok){ const e = await res.json(); $('err').textContent = e.error||'failed'; return; }
  // BUG: console-error logs an error even though the UI proceeds.
  if (BUG==='console-error') console.error('[genapp] post-add invariant check failed');
  $('amount').value=''; $('note').value='';
  await load();
});
document.getElementById('list').addEventListener('click', async (ev) => {
  const id = ev.target.getAttribute('data-id'); if(!id) return;
  await fetch('/api/expenses/'+id, {method:'DELETE'});
  await load();
});
load();
</script>
</body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(PAGE(BUG));
  }
  res.writeHead(404);
  return res.end('not found');
});

server.listen(PORT, () => {
  console.log(`[genapp] Expense Tracker on http://localhost:${PORT}  (BUG_MODE=${BUG})`);
});
