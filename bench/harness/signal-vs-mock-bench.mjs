// Signal-vs-mock (the wedge demo): backend-contract regressions that render PIXEL-IDENTICAL, so the two
// incumbent oracle classes certify them green while an app-signal oracle catches them red.
//
//   Oracle A — visual/DOM diff (Antigravity, Percy, Meticulous's visual layer): sees only painted pixels.
//   Oracle B — network-mock replay (Meticulous-style): serves RECORDED responses at replay, so a LIVE
//              backend change never reaches it ("only catches frontend regressions" — their words).
//   Oracle C — Iris app-signal: asserts on the LIVE network payload / emitted signal.
//
// Honest by construction: we stand up a real fixture server, RECORD baseline responses (the mock), then
// flip only the BACKEND (?regress=1) and fetch LIVE. Each oracle's verdict falls out of real data — the
// UI render() is identical across baseline/regressed (that's the whole point), the mock evaluates the
// recorded body, and the signal oracle evaluates the live body. No hand-waving.
import { writeFileSync } from 'node:fs';
import http from 'node:http';

// Each scenario: the baseline (correct) body, the regressed body, render() = the exact text the UI paints
// (deliberately omitting non-displayed fields / collapsing to a generic state), and contract() = the
// app-signal assertion of correctness over a body.
const SCENARIOS = [
  {
    id: 'dropped-field',
    desc: 'GET /orders drops customerId (UI renders id/total/status only; downstream "email customer" breaks)',
    baseline: { id: 'o1', total: 42, status: 'paid', customerId: 'c1' },
    regressed: { id: 'o1', total: 42, status: 'paid' }, // customerId gone
    render: (b) => `Order ${b.id} — $${b.total} — ${b.status}`, // customerId never painted
    contract: (b) => typeof b.customerId === 'string' && b.customerId.length > 0,
  },
  {
    id: 'wrong-body-200',
    desc: 'POST /checkout returns 200 but status flips confirmed→pending (UI shows generic "Thanks!")',
    baseline: { httpStatus: 200, status: 'confirmed' },
    regressed: { httpStatus: 200, status: 'pending' },
    render: () => 'Thanks! Your order is in.', // generic toast either way
    contract: (b) => b.status === 'confirmed',
  },
  {
    id: 'pagination-cursor',
    desc: 'GET /items?cursor returns a duplicate nextCursor; page 2 silently refetches page 1',
    baseline: { page1First: 'i1', page2First: 'i9', nextCursorAdvances: true },
    regressed: { page1First: 'i1', page2First: 'i1', nextCursorAdvances: false }, // page2 == page1
    render: (b) => `Showing items starting ${b.page1First}`, // page 1 looks perfect
    contract: (b) => b.page2First !== b.page1First && b.nextCursorAdvances === true,
  },
  {
    id: 'auth-scope-downgrade',
    desc: 'GET /admin/metrics drops a scope → 403; widget silent-catches and renders an empty "no data" state',
    baseline: { httpStatus: 200, value: 1234 },
    regressed: { httpStatus: 403, value: null },
    render: (b) => (b.value === null ? 'No data this period' : 'No data this period'), // empty-looking either way
    contract: (b) => b.httpStatus === 200 && typeof b.value === 'number',
  },
];

// A real fixture server: ?regress=1 flips ONLY the backend body. We fetch it live; the mock is what we
// recorded earlier. This makes the live-vs-recorded distinction physical, not asserted.
function startFixture() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const sc = SCENARIOS.find((s) => u.pathname === `/${s.id}`);
    res.setHeader('Content-Type', 'application/json');
    if (!sc) {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    const body = u.searchParams.get('regress') === '1' ? sc.regressed : sc.baseline;
    res.writeHead(body.httpStatus ?? 200);
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function getJson(port, path) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return r.json();
}

const CAUGHT = 'CAUGHT'; // oracle flagged the regression (red — good)
const MISSED = 'MISSED'; // oracle certified it green (blind)

const server = await startFixture();
const port = server.address().port;
const rows = [];
for (const sc of SCENARIOS) {
  const recorded = await getJson(port, `/${sc.id}`); // baseline → the mock's frozen response
  const live = await getJson(port, `/${sc.id}?regress=1`); // live regressed backend

  // A) visual/DOM diff: identical paint across baseline vs live regressed → blind.
  const visual = sc.render(recorded) !== sc.render(live) ? CAUGHT : MISSED;
  // B) network-mock replay: evaluates the RECORDED (mocked) response, never the live one → blind.
  const mock = sc.contract(recorded) ? MISSED : CAUGHT;
  // C) Iris app-signal: evaluates the LIVE response contract → catches.
  const signal = sc.contract(live) ? MISSED : CAUGHT;

  rows.push({
    scenario: sc.id,
    desc: sc.desc,
    visual_diff: visual,
    network_mock: mock,
    iris_signal: signal,
  });
}
server.close();

const caughtBy = (k) => rows.filter((r) => r[k] === CAUGHT).length;
const out = {
  metric: 'signal-vs-mock — backend-contract regressions that render pixel-identical',
  oracles: {
    visual_diff: {
      caught: caughtBy('visual_diff'),
      of: rows.length,
      blind_because: 'sees only painted pixels; the regression is never rendered',
    },
    network_mock: {
      caught: caughtBy('network_mock'),
      of: rows.length,
      blind_because: 'replays recorded responses; the live backend change never reaches it',
    },
    iris_signal: {
      caught: caughtBy('iris_signal'),
      of: rows.length,
      asserts: 'the live network payload / emitted signal against the contract',
    },
  },
  rows,
  headline:
    'Iris is the only all-CAUGHT column. Visual-diff and network-mock oracles certify a broken backend as shipping-ready.',
  honest_caveat:
    'This wedge is backend-contract / state correctness. The reverse is also true: for pure presentation bugs (CSS overlap, offscreen button, contrast), signals/state are correct and visual-diff wins. The oracles are COMPLEMENTARY — Iris is strictly superior here, strictly inferior on pixel-only bugs and zero-integration/opaque apps.',
};
console.log(JSON.stringify(out, null, 2));
writeFileSync('bench/raw/signal-vs-mock.json', JSON.stringify(out, null, 2));
