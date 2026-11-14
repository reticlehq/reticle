// `reticle verify` through the built CLI, when one flow leaves the app for a page with no SDK
// (#2060). Prints through process.stdout.write: the repository asks for no console logging.
//
// The app here has pages with the SDK, and one 404 page without it. Flow `b-dead` clicks a link to
// the 404 page, so the session drops and no session connects there. Before the fix, the next flows
// were replayed with no session: each one waited and got the generic "check your port" reason, so
// their verdicts were lost. The unit tests use a fake port. Only a real browser can show that the
// driven page goes back to the start URL and that its SDK connects again.
//
// Serves its own pages and its own copy of the SDK bundle, so it needs no app from run-ci.sh.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_BRIDGE_PORT } from '../gate-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(ROOT, 'server/dist/command/cli.js');
const SDK_JS = readFileSync(path.join(ROOT, 'adapters/realm/browser/dist/reticle-inject.js'), 'utf8');
const TOKEN = randomBytes(24).toString('hex');
const DEAD_PATH = '/stats?id=missing';
const NO_SESSION_AFTER_NAVIGATION = 'no session after navigation';

let pass = 0,
  fail = 0;
const say = (line) => process.stdout.write(`${line}\n`);
const chk = (label, ok, detail = '') => {
  say(`   ${ok ? '✅' : '❌'} ${label}${ok || !detail ? '' : '  — ' + detail}`);
  ok ? pass++ : fail++;
};

const sdkPage = (body) =>
  `<!doctype html><html><head><title>fixture</title></head><body>
<script src="/reticle-inject.js"></script>
<script>ReticleSdk.reticle.connect({ url: ${JSON.stringify(`ws://127.0.0.1:${String(TEST_BRIDGE_PORT)}`)}, token: ${JSON.stringify(TOKEN)} });</script>
${body}</body></html>`;

const HOME = `<h1>Home</h1>
<button data-testid="inc" onclick="document.getElementById('count').textContent=String(Number(document.getElementById('count').textContent)+1);ReticleSdk.reticle.signal('added')">Add</button>
<p>Count: <span id="count">0</span></p>
<button data-testid="greet" onclick="document.getElementById('hello').hidden=false;ReticleSdk.reticle.signal('greeted')">Greet</button>
<p id="hello" hidden>Hello</p>
<a data-testid="go-dead" href="${DEAD_PATH}">Stats</a>`;

async function serve() {
  const server = createServer((req, res) => {
    const where = new URL(req.url ?? '/', 'http://x').pathname;
    if (where === '/reticle-inject.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(SDK_JS);
      return;
    }
    res.setHeader('content-type', 'text/html');
    if (where === '/stats') {
      // A server's own error page: it does not load the SDK.
      res.statusCode = 404;
      res.end('<!doctype html><title>not found</title><h1>No such link</h1><button data-testid="back">Back</button>');
      return;
    }
    res.end(sdkPage(HOME));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${String(server.address().port)}/` };
}

const step = (testid, signal) => ({
  tool: 'reticle_act',
  anchor: { kind: 'testid', value: testid },
  action: 'click',
  args: {},
  ...(signal === undefined ? {} : { expect: { signal } }),
});

function writeFlows(dir) {
  const flows = path.join(dir, '.reticle', 'flows');
  mkdirSync(flows, { recursive: true });
  const write = (name, steps) =>
    writeFileSync(
      path.join(flows, `${name}.json`),
      JSON.stringify({ version: 2, name, createdAt: 0, steps }, null, 2),
    );
  write('a-add', [step('inc', 'added')]);
  write('b-dead', [step('go-dead'), step('back')]);
  write('c-greet', [step('greet', 'greeted')]);
  write('d-add', [step('inc', 'added')]);
}

function verify(cwd, url, resultsJson) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [CLI, 'verify', url, '--port', String(TEST_BRIDGE_PORT), '--results-json', resultsJson],
      {
        cwd,
        env: {
          ...process.env,
          RETICLE_TOKEN: TOKEN,
          RETICLE_TELEMETRY: '0',
          RETICLE_NO_VERSION_MATCH: '1',
          RETICLE_BACKGROUND_SYNC: '0',
          CI: 'true',
        },
      },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    // A bound, not a duration (AGENTS.md rule 15).
    const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

say('\n=== VERIFY: a flow that leaves the app for a page with no SDK (#2060) ===');

const app = await serve();
const dir = mkdtempSync(path.join(tmpdir(), 'reticle-verify-session-lost-'));
try {
  writeFlows(dir);
  const resultsJson = path.join(dir, 'results.json');
  const run = await verify(dir, app.url, resultsJson);
  const tail = run.out.trim().split('\n').slice(-8).join(' | ').slice(0, 1200);
  chk('verify wrote its results', existsSync(resultsJson), `exit ${String(run.code)}: ${tail}`);
  const results = existsSync(resultsJson)
    ? JSON.parse(readFileSync(resultsJson, 'utf8')).results
    : [];
  const of = (name) => results.find((r) => r.journey === name);
  chk('the flow before the dead page passes', of('a-add')?.verdict === 'yes', JSON.stringify(of('a-add')));
  const dead = of('b-dead');
  chk('the flow that left the app is not a pass', dead !== undefined && dead.verdict !== 'yes', JSON.stringify(dead));
  chk(
    '  and its reason says the session was lost after navigation',
    (dead?.reason ?? '').startsWith(NO_SESSION_AFTER_NAVIGATION),
    dead?.reason ?? 'no reason',
  );
  chk('  and names the URL of the dead page', (dead?.reason ?? '').includes(DEAD_PATH), dead?.reason ?? 'no reason');
  for (const name of ['c-greet', 'd-add']) {
    chk(`the later flow ${name} gets its own verdict and passes`, of(name)?.verdict === 'yes', JSON.stringify(of(name)));
  }
} catch (err) {
  chk('the spec ran to the end', false, String(err).slice(0, 300));
} finally {
  app.server.close();
  rmSync(dir, { recursive: true, force: true });
}

say(`\n${fail === 0 ? '✅' : '❌'} VERIFY SESSION LOST (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
