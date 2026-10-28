// Bare `reticle` in an unwired web-app folder ends in a verdict, with no agent and no `init`.
// Prints through process.stdout.write: the repository asks for no console logging.
//
// It starts the folder's dev server, opens the page in a Reticle browser with the zero-install
// reader, and runs the smoke check: the page loads, no console error, no failed request, and each
// same-origin link opens. No unit test can see this, because the facts come from a real page in a
// real browser. The check must be able to FAIL, so the spec runs it on a clean app and on a broken
// one. The broken page is broken only behind a link, so a check that never opens links passes it.
//
// The fixture is written here, into a new folder: a `package.json` whose dev script serves two
// small apps. Nothing is installed in it, and nothing in it names Reticle.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_BRIDGE_PORT, startOwnedDaemon } from '../gate-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'server/dist/command/cli.js');

let pass = 0;
let fail = 0;
const say = (line) => process.stdout.write(`${line}\n`);
const chk = (label, ok, detail = '') => {
  say(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
const portOpen = (port) =>
  new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });

// The app. `--broken` makes /broken throw and ask for an API that is not there.
const SERVER = `
import { createServer } from 'node:http';
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const broken = process.argv.includes('--broken');
const page = (title, body) =>
  '<!doctype html><html><head><title>' + title + '</title></head><body>' +
  '<nav><a href="/">Home</a> <a href="/about">About</a> <a href="/broken">Status</a></nav>' +
  body + '</body></html>';
const PAGES = {
  '/': page('home', '<h1>Home</h1><script>fetch("/api/ok")</script>'),
  '/about': page('about', '<h1>About</h1>'),
  '/broken': broken
    ? page('status', '<h1>Status</h1><script>fetch("/api/missing"); throw new Error("status page broke")</script>')
    : page('status', '<h1>Status</h1>'),
};
createServer((req, res) => {
  const route = new URL(req.url ?? '/', 'http://x').pathname;
  if (route === '/api/ok') { res.setHeader('content-type', 'application/json'); res.end('{}'); return; }
  const html = PAGES[route];
  res.statusCode = html === undefined ? 404 : 200;
  res.setHeader('content-type', 'text/html');
  res.end(html ?? 'not found');
}).listen(port, '127.0.0.1', () => process.stdout.write('ready on http://localhost:' + port + '\\n'));
`;

function appFolder(port, broken) {
  const dir = mkdtempSync(path.join(tmpdir(), 'reticle-first-verdict-'));
  writeFileSync(path.join(dir, 'server.mjs'), SERVER);
  const flags = broken ? '--broken --port' : '--port';
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'first-verdict-app',
      private: true,
      scripts: { dev: `node server.mjs ${flags} ${String(port)}` },
    }),
  );
  return dir;
}

/** Bare `reticle`, in `cwd`, as a person types it. */
function bare(cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI], {
      cwd,
      env: {
        ...process.env,
        RETICLE_PORT: String(TEST_BRIDGE_PORT),
        RETICLE_TELEMETRY: '0',
        RETICLE_NO_VERSION_MATCH: '1',
        CI: 'true',
      },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    // A bound, not a duration (AGENTS.md rule 15).
    const timer = setTimeout(() => child.kill('SIGKILL'), 240_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

say('\n=== FIRST VERDICT: bare `reticle` in an unwired app folder ===');

const daemon = await startOwnedDaemon(TEST_BRIDGE_PORT, { cliPath: CLI, cwd: ROOT });
const folders = [];
try {
  const cleanPort = await freePort();
  const clean = appFolder(cleanPort, false);
  folders.push(clean);
  const passed = await bare(clean);
  const lastLine = passed.out.trim().split('\n').slice(-6).join(' | ');
  chk('a clean app exits 0', passed.code === 0, `exit ${String(passed.code)}: ${lastLine}`);
  chk('  and says verified: yes', passed.out.includes('verified: yes'));
  chk('  and opened its links', /2 of 2 link\(s\) opened with no fault/.test(passed.out));
  chk('  and names the next step', passed.out.includes('npx @reticlehq/server init'));
  chk('  and stopped the dev server it started', !(await portOpen(cleanPort)));

  const brokenPort = await freePort();
  const broken = appFolder(brokenPort, true);
  folders.push(broken);
  const failed = await bare(broken);
  chk('a broken app exits 1', failed.code === 1, `exit ${String(failed.code)}`);
  chk(
    '  and says verified: no',
    failed.out.includes('verified: no'),
    failed.out.trim().split('\n').slice(-6).join(' | '),
  );
  chk(
    '  and names the console error on the linked page',
    /Console error on \/broken: .*status page broke/.test(failed.out),
  );
  chk(
    '  and names the failed request',
    /Failed request on \/broken: GET .*\/api\/missing: HTTP 404/.test(failed.out),
  );
  chk('  and stopped the dev server it started', !(await portOpen(brokenPort)));
} catch (err) {
  chk('the spec ran to the end', false, String(err).slice(0, 300));
} finally {
  await daemon.stop();
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
}

say(`\n${fail === 0 ? '✅' : '❌'} FIRST VERDICT (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
