// `reticle verify` through the built CLI, when one flow leaves the app for a page with no SDK
// (#2060). Prints through process.stdout.write: the repository asks for no console logging.
//
// The app here has pages with the SDK, and one 404 page without it. Flow `b-dead` clicks a link to
// the 404 page, so the session drops and no session connects there. Before the fix, the next flows
// were replayed with no session: each one waited and got the generic "check your port" reason, so
// their verdicts were lost. The unit tests use a fake port. Only a real browser can show that the
// driven page goes back to the start URL and that its SDK connects again.
//
// The second run also opens the user's own tab of the app on the same bridge. Review of #2261: the
// run then took the user's tab for the driven page. Flow b-dead got no session-loss reason, and
// the later flows clicked in the user's tab while the driven page stayed on the 404 page.
//
// Serves its own pages and its own copy of the SDK bundle, so it needs no app from run-ci.sh.
import { chromium } from 'playwright';
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
<a data-testid="go-dead" href="${DEAD_PATH}">Stats</a>
<a data-testid="go-other" href="/other">Other</a>`;

/** How long the server holds the late SDK, as a dev server that compiles a module graph does. */
const LATE_SDK_MS = 3000;
/** The SDK and its connect, as one module. It sets the global singleton when it runs. */
const LATE_SDK_MODULE = `${SDK_JS}
ReticleSdk.reticle.connect({ url: ${JSON.stringify(`ws://127.0.0.1:${String(TEST_BRIDGE_PORT)}`)}, token: ${JSON.stringify(TOKEN)} });`;
/**
 * A healthy page of the app whose SDK arrives late: `module` loads it as a module script, the way
 * the Vite plugin injects it, and `dynamic` loads it with import(), the way `init` wires CRA, Remix,
 * Nuxt and Angular. In both, the document has left `loading` before the SDK global exists.
 */
const OTHER = {
  module: '<script type="module" src="/late-sdk.mjs"></script>',
  dynamic: '<script type="module">import("/late-sdk.mjs");</script>',
};

async function serve(late = 'module') {
  // A load of the stamped start URL: the first load, and each time the run opens the app again.
  const stamped = { loads: 0 };
  const server = createServer((req, res) => {
    const asked = new URL(req.url ?? '/', 'http://x');
    const where = asked.pathname;
    if (where === '/reticle-inject.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(SDK_JS);
      return;
    }
    if (where === '/late-sdk.mjs') {
      setTimeout(() => {
        res.setHeader('content-type', 'text/javascript');
        res.end(LATE_SDK_MODULE);
      }, LATE_SDK_MS);
      return;
    }
    res.setHeader('content-type', 'text/html');
    if (where === '/other') {
      res.end(`<!doctype html><title>other</title><h1>Other</h1>${OTHER[late]}`);
      return;
    }
    if (where === '/stats') {
      // A server's own error page: it does not load the SDK.
      res.statusCode = 404;
      res.end('<!doctype html><title>not found</title><h1>No such link</h1><button data-testid="back">Back</button>');
      return;
    }
    if (asked.searchParams.has('__reticle_opened')) {
      stamped.loads += 1;
    }
    res.end(sdkPage(HOME));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, stamped, url: `http://127.0.0.1:${String(server.address().port)}/` };
}

const step = (testid, signal) => ({
  tool: 'reticle_act',
  anchor: { kind: 'testid', value: testid },
  action: 'click',
  args: {},
  ...(signal === undefined ? {} : { expect: { signal } }),
});

function flowWriter(dir) {
  const flows = path.join(dir, '.reticle', 'flows');
  mkdirSync(flows, { recursive: true });
  return (name, steps, extra = {}) =>
    writeFileSync(
      path.join(flows, `${name}.json`),
      JSON.stringify({ version: 2, name, createdAt: 0, steps, ...extra }, null, 2),
    );
}

/**
 * `lastStepDead`: the LAST step of b-dead goes to the 404 page, as in #2060 (Kutt). The check
 * after the flow then runs before the old document's socket has closed. The second review of
 * #2261 found that the loss was missed there, and the next flow got the blame.
 */
function writeFlows(dir, lastStepDead = false) {
  const write = flowWriter(dir);
  write('a-add', [step('inc', 'added')]);
  write('b-dead', lastStepDead ? [step('go-dead')] : [step('go-dead'), step('back')]);
  write('c-greet', [step('greet', 'greeted')]);
  write('d-add', [step('inc', 'added')]);
}

/** The last step of a-nav goes to a healthy page whose SDK is late. The later flows start at `/`. */
/**
 * A step budget well above LATE_SDK_MS. The first step's timeout raises the start-page wait
 * (startPathBudgetMs), so the late SDK has room on a loaded machine.
 */
const LATE_STEP_TIMEOUT_MS = 20_000;

function writeLateFlows(dir) {
  const write = flowWriter(dir);
  const late = (testid, signal) => ({ ...step(testid, signal), timeoutMs: LATE_STEP_TIMEOUT_MS });
  write('a-nav', [late('go-other')]);
  write('b-add', [late('inc', 'added')], { startPath: '/' });
  write('c-add', [late('inc', 'added')], { startPath: '/' });
}

/** A verify log line for a new session: the driven page's SDK has connected. */
const SESSION_CONNECTED = '"event":"session_connected"';

function verify(cwd, url, resultsJson, onOutput) {
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
    const take = (d) => {
      out += d;
      onOutput?.(out);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    // A bound, not a duration (AGENTS.md rule 15).
    const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/**
 * One run of the four flows. With `userTab`, a second page of the same app (the user's own tab) is
 * open and connected to the same bridge while the run drives its own page. The run must stay on the
 * page that it drives. A later flow that clicks in the user's tab gives a pass about the wrong page.
 */
async function scenario(label, { userTab, lastStepDead = false }) {
  say(`\n--- ${label} ---`);
  const app = await serve();
  const dir = mkdtempSync(path.join(tmpdir(), 'reticle-verify-session-lost-'));
  // RETICLE_CHROMIUM_PATH names the Chromium that `reticle verify` launches. The user's tab uses
  // the same one, so both pages run in one known browser build.
  const executablePath = process.env.RETICLE_CHROMIUM_PATH;
  const browser = userTab
    ? await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
    : undefined;
  let opened;
  try {
    writeFlows(dir, lastStepDead);
    const resultsJson = path.join(dir, 'results.json');
    // The user's tab opens after the driven page connected, so the run starts on its own page.
    const run = await verify(dir, app.url, resultsJson, (out) => {
      if (browser !== undefined && opened === undefined && out.includes(SESSION_CONNECTED)) {
        opened = browser.newPage().then(async (page) => {
          await page.goto(app.url);
          return page;
        });
      }
    });
    if (process.env.RETICLE_SPEC_VERBOSE === '1') {
      say(run.out);
    }
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
    if (browser !== undefined) {
      const page = await opened;
      chk('the user tab was open during the run', page !== undefined);
      // The flows click "Add" and "Greet". Neither click may land in the user's tab.
      const count = await page?.textContent('#count');
      const greeted = await page?.isVisible('#hello');
      chk(
        '  and no flow clicked in it',
        count === '0' && greeted === false,
        `count=${String(count)} greeted=${String(greeted)}`,
      );
    }
  } catch (err) {
    chk('the scenario ran to the end', false, String(err).slice(0, 300));
  } finally {
    await browser?.close();
    app.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

say('\n=== VERIFY: a flow that leaves the app for a page with no SDK (#2060) ===');

/**
 * Review of #2261: a healthy page whose SDK loads late. The page's document had left `loading`, the
 * SDK global was not there yet, and the run reported "no session after navigation" (the false
 * reason of #2060) and loaded the start URL again. Such a page connects within the wait that
 * replay gives a start page, so nothing was lost.
 */
async function lateScenario(late) {
  say(`\n--- a healthy page whose SDK loads late (${late}) ---`);
  const app = await serve(late);
  const dir = mkdtempSync(path.join(tmpdir(), 'reticle-verify-session-late-'));
  try {
    writeLateFlows(dir);
    const resultsJson = path.join(dir, 'results.json');
    const run = await verify(dir, app.url, resultsJson);
    if (process.env.RETICLE_SPEC_VERBOSE === '1') {
      say(run.out);
    }
    const tail = run.out.trim().split('\n').slice(-8).join(' | ').slice(0, 1200);
    chk('verify wrote its results', existsSync(resultsJson), `exit ${String(run.code)}: ${tail}`);
    const results = existsSync(resultsJson)
      ? JSON.parse(readFileSync(resultsJson, 'utf8')).results
      : [];
    const of = (name) => results.find((r) => r.journey === name);
    const nav = of('a-nav');
    chk('the flow ran', nav !== undefined, JSON.stringify(results));
    chk(
      '  and its reason does not say that the session was lost',
      !(nav?.reason ?? '').includes(NO_SESSION_AFTER_NAVIGATION),
      nav?.reason ?? 'no reason',
    );
    chk('the run did not open the start URL again', app.stamped.loads === 1, `stamped loads=${String(app.stamped.loads)}`);
    for (const name of ['b-add', 'c-add']) {
      chk(`the later flow ${name} passes`, of(name)?.verdict === 'yes', JSON.stringify(of(name)));
    }
  } catch (err) {
    chk('the scenario ran to the end', false, String(err).slice(0, 300));
  } finally {
    app.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

await scenario('the driven page is the only tab', { userTab: false });
await scenario("the user's own tab of the app is also connected", { userTab: true });
await scenario('the last step of the flow goes to the dead page', {
  userTab: false,
  lastStepDead: true,
});
await lateScenario('module');
await lateScenario('dynamic');

say(`\n${fail === 0 ? '✅' : '❌'} VERIFY SESSION LOST (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
