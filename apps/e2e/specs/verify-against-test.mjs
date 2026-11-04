// `reticle verify <candidate> --against <reference>`, end to end, through the built CLI (#2190).
// Prints through process.stdout.write: the repository asks for no console logging.
//
// Three builds of one tiny app, served here: the reference, a copy of it, and a copy where one
// button reads "Store" in place of "Save". The project has one saved flow that opens the panel and
// clicks that button. A unit test drives a fake app; only a real daemon, real leases and the real
// replay tool can show that the per-step replay and the reads after each step work together.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_BRIDGE_PORT, startOwnedDaemon } from '../gate-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(ROOT, 'server/dist/command/cli.js');

let pass = 0,
  fail = 0;
const say = (line) => process.stdout.write(`${line}\n`);
const chk = (label, ok, detail = '') => {
  say(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const page = (label) =>
  '<!doctype html><title>shop</title><h1>Shop</h1>' +
  '<button data-testid="open" onclick="document.getElementById(\'panel\').hidden=false">Open</button>' +
  '<div id="panel" hidden><p>Panel open</p>' +
  `<button data-testid="save" onclick="document.getElementById('done').hidden=false">${label}</button>` +
  '<p id="done" hidden>Done</p></div>';

async function serve(label) {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(page(label));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${String(server.address().port)}/` };
}

/** A project folder with one saved flow: open the panel, then press its button. */
function project() {
  const dir = mkdtempSync(path.join(tmpdir(), 'reticle-verify-against-'));
  mkdirSync(path.join(dir, '.reticle', 'flows'), { recursive: true });
  const step = (testid) => ({
    tool: 'reticle_act',
    anchor: { kind: 'testid', value: testid },
    action: 'click',
    args: {},
  });
  writeFileSync(
    path.join(dir, '.reticle', 'flows', 'open-panel.json'),
    JSON.stringify({ version: 2, name: 'open-panel', createdAt: 0, steps: [step('open'), step('save')] }),
  );
  return dir;
}

function verifyAgainst(cwd, candidate, reference, json) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [CLI, 'verify', candidate, '--against', reference, '--results-json', json, '--port', String(TEST_BRIDGE_PORT)],
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
      let report;
      try {
        report = JSON.parse(readFileSync(json, 'utf8'));
      } catch {
        report = undefined;
      }
      resolve({ code, out, report });
    });
  });
}

say('\n=== VERIFY --AGAINST: what a change altered in what users see ===');

const daemon = await startOwnedDaemon(TEST_BRIDGE_PORT, { cliPath: CLI, cwd: ROOT });
const apps = await Promise.all([serve('Save'), serve('Save'), serve('Store')]);
const [reference, same, changed] = apps;
const dir = project();
try {
  const agree = await verifyAgainst(dir, same.url, reference.url, path.join(dir, 'same.json'));
  const tail = (out) => out.trim().split('\n').slice(-8).join(' | ');
  chk('two identical builds exit 0', agree.code === 0, `exit ${String(agree.code)}: ${tail(agree.out)}`);
  chk('  and report no difference', agree.report?.identical === true && agree.report?.differences?.length === 0);
  chk('  and compared steps of the saved flow and the explorer', (agree.report?.compared ?? 0) > 2,
    `compared ${String(agree.report?.compared)}`);

  const differ = await verifyAgainst(dir, changed.url, reference.url, path.join(dir, 'changed.json'));
  const found = differ.report?.differences ?? [];
  chk('a build with one renamed button exits 1', differ.code === 1, `exit ${String(differ.code)}: ${tail(differ.out)}`);
  chk('  and reports exactly one difference', found.length === 1, JSON.stringify(found).slice(0, 400));
  chk(
    '  and it is that button: - save, + store',
    found[0]?.kind === 'changed' &&
      JSON.stringify(found[0]?.removed) === '["save"]' &&
      JSON.stringify(found[0]?.added) === '["store"]',
  );
  chk('  and prints the - and + lines', differ.out.includes('  - save') && differ.out.includes('  + store'));

  const again = await verifyAgainst(dir, changed.url, reference.url, path.join(dir, 'again.json'));
  chk(
    'the same two builds give the same difference id on a second run',
    found.length > 0 && JSON.stringify(again.report?.differences?.map((d) => d.id)) === JSON.stringify(found.map((d) => d.id)),
  );
} catch (err) {
  chk('the spec ran to the end', false, String(err).slice(0, 300));
} finally {
  for (const app of apps) app.server.close();
  await daemon.stop();
  rmSync(dir, { recursive: true, force: true });
}

say(`\n${fail === 0 ? '✅' : '❌'} VERIFY --AGAINST (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
