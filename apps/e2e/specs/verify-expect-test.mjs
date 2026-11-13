// `reticle verify <url> --expect <predicate>`, end to end, through the built CLI (#2144).
// Prints through process.stdout.write: the repository asks for no console logging.
//
// The page shows "loading" and sets its text 2 s after load. The unit tests drive a fake daemon and
// check only the names and arguments it was sent, and that is how a CLI that called a merged tool
// name shipped: a 3.9.0 daemon answered it with "was merged into reticle_assert", and every
// `--expect` run printed `verified: unknown`. Only a real daemon, a real lease and the real assert
// can show that the wait and the grade work together.
//
// The long `--timeout` takes the path that waits in `reticle_assert { action: "wait" }` before the
// final assert. A budget longer than two requests sends that wait more than one request may block,
// which the merged surface refused before its `timeout_ms` took each action's own bound.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_BRIDGE_PORT, startOwnedDaemon } from '../gate-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(ROOT, 'server/dist/command/cli.js');
const READY_TEXT = 'Orders ready';
/** Longer than two requests of `reticle_assert` (55 s each), so the wait is asked for more than one. */
const LONG_TIMEOUT_MS = 120_000;
const SHORT_TIMEOUT_MS = 2_000;

let pass = 0,
  fail = 0;
const say = (line) => process.stdout.write(`${line}\n`);
const chk = (label, ok, detail = '') => {
  say(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const page =
  '<!doctype html><title>orders</title><p id="status">loading</p>' +
  `<script>setTimeout(() => { document.getElementById('status').textContent = '${READY_TEXT}'; }, 2000);</script>`;

async function serve() {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(page);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${String(server.address().port)}/` };
}

function verifyExpect(cwd, url, contains, timeoutMs) {
  return new Promise((resolve) => {
    const predicate = JSON.stringify({ kind: 'text', contains });
    const child = spawn(
      process.execPath,
      [CLI, 'verify', url, '--expect', predicate, '--timeout', String(timeoutMs), '--port', String(TEST_BRIDGE_PORT)],
      {
        cwd,
        env: { ...process.env, RETICLE_TELEMETRY: '0', RETICLE_NO_VERSION_MATCH: '1', CI: 'true' },
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

const firstLines = (out) => out.trim().split('\n').slice(0, 2).join(' | ');

say('\n=== VERIFY --EXPECT: a verdict from the CLI against the running daemon ===');

const daemon = await startOwnedDaemon(TEST_BRIDGE_PORT, { cliPath: CLI, cwd: ROOT });
const app = await serve();
const dir = mkdtempSync(path.join(tmpdir(), 'reticle-verify-expect-'));
try {
  const held = await verifyExpect(dir, app.url, READY_TEXT, LONG_TIMEOUT_MS);
  chk(
    'text that appears 2 s after load, with a long --timeout, exits 0',
    held.code === 0,
    `exit ${String(held.code)}: ${firstLines(held.out)}`,
  );
  chk('  and prints verified: yes', held.out.includes('verified: yes'), firstLines(held.out));
  chk('  and never names a merged tool', !held.out.includes('was merged into'));

  const shortWait = await verifyExpect(dir, app.url, READY_TEXT, 30_000);
  chk(
    'the same text with a --timeout that one assert holds exits 0',
    shortWait.code === 0 && shortWait.out.includes('verified: yes'),
    `exit ${String(shortWait.code)}: ${firstLines(shortWait.out)}`,
  );

  // The check must be able to fail: text the page never shows is a `no`, not a pass.
  const never = await verifyExpect(dir, app.url, 'Orders failed', SHORT_TIMEOUT_MS);
  chk(
    'text the page never shows exits 1 with verified: no',
    never.code === 1 && never.out.includes('verified: no'),
    `exit ${String(never.code)}: ${firstLines(never.out)}`,
  );
} catch (err) {
  chk('the spec ran to the end', false, String(err).slice(0, 300));
} finally {
  app.server.close();
  await daemon.stop();
  rmSync(dir, { recursive: true, force: true });
}

say(`\n${fail === 0 ? '✅' : '❌'} VERIFY --EXPECT (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
