#!/usr/bin/env node
/**
 * One arm of the Harness-versus-agent benchmark, driven headless against a real app.
 *
 *   node bench/harness-vs-agent/run.mjs --arm harness-app [--runs 3] [--keep-flows]
 *
 * Arms (what the calling agent is told to do):
 *   agent-app        verify the whole app itself, with Reticle's tools
 *   harness-app      hand the whole app to the Harness (`explore` with no persona)
 *   agent-journey    verify one named journey itself
 *   harness-journey  hand that journey to the Harness
 *
 * Every tool call lands in `tools.jsonl` (RETICLE_TOOL_LOG), the agent's own stream in
 * `agent-stream.jsonl`, and a summary in `metrics.json`. `judge.mjs` scores the reports against the
 * fixture's ground truth afterwards; `report.mjs` tabulates every run in a directory.
 *
 * Environment (required): BENCH_APP_DIR (the app, e.g. reticle-fixtures/.../merchant-dashboard),
 * BENCH_APP_PORT, and for the Harness arms RETICLE_CLOUD_URL + RETICLE_API_KEY of a linked project.
 * Optional: BENCH_DAEMON_PORT (4410), BENCH_JOURNEY, BENCH_MODEL (sonnet), BENCH_OUT.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  cpSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(REPO, 'server/bin/reticle.js');
const ARMS = ['agent-app', 'harness-app', 'agent-journey', 'harness-journey'];
const DEFAULT_JOURNEY =
  'A merchant ops manager refunds a captured payment from the Transactions page, then turns on automatic refunds in Settings.';
const AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 90_000;

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : (process.argv[at + 1] ?? fallback);
};
const flag = (name) => process.argv.includes(`--${name}`);
const need = (key) => {
  const value = process.env[key];
  if (value === undefined || value.length === 0) throw new Error(`set ${key}`);
  return value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Every child this script started, stopped however the script ends, a crash included. */
const alive = new Set();
process.on('exit', () => {
  for (const child of alive) child.kill();
});

const arm = arg('arm', '');
if (!ARMS.includes(arm)) throw new Error(`--arm must be one of ${ARMS.join(', ')}`);
const runs = Number(arg('runs', '1'));
const appDir = resolve(need('BENCH_APP_DIR'));
const appPort = Number(need('BENCH_APP_PORT'));
const daemonPort = Number(process.env.BENCH_DAEMON_PORT ?? '4410');
const journey = process.env.BENCH_JOURNEY ?? DEFAULT_JOURNEY;
const model = process.env.BENCH_MODEL ?? 'sonnet';
const harness = arm.startsWith('harness');
if (harness) {
  need('RETICLE_CLOUD_URL');
  need('RETICLE_API_KEY');
}
const outRoot = resolve(process.env.BENCH_OUT ?? join(REPO, 'bench/artifacts/harness-vs-agent'));
const appUrl = `http://localhost:${String(appPort)}`;

function promptFor() {
  const look = `The app is running at ${appUrl} and is open in a browser tab connected to Reticle.`;
  const report = 'Report every defect you find, with its evidence.';
  if ('agent-app' === arm)
    return `${look} Verify the WHOLE app yourself with the Reticle MCP tools: every page and every action a user can take. Prove each outcome with reticle_act_and_wait. Do not read or edit source code. ${report} When done, call reticle_session with action yield.`;
  if ('agent-journey' === arm)
    return `${look} Journey: ${journey} Verify that journey end to end yourself with the Reticle MCP tools, proving each outcome with reticle_act_and_wait. Do not read or edit source code. ${report} When done, call reticle_session with action yield.`;
  if ('harness-app' === arm)
    return `${look} Do NOT drive it yourself: call reticle_verify with action "explore" and NO persona, so Reticle's Harness plans and drives the whole app. Then ${report.toLowerCase()} Include its usage.`;
  return `${look} Journey: ${journey} Do NOT drive it yourself: hand the whole journey to Reticle's Harness in ONE call, reticle_verify with action "explore" and persona set to the journey. Then ${report.toLowerCase()} Include its usage.`;
}

function killPort(port) {
  // The LISTENER only: a bare `lsof -ti` also matches every client of the port, including MCP
  // proxies, and SIGKILLs them.
  const pids = spawnSync('lsof', ['-ti', `tcp:${String(port)}`, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  })
    .stdout.split('\n')
    .filter(Boolean);
  for (const pid of pids) spawnSync('kill', [pid]);
}

async function waitFor(check, ms, what) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function oneRun(index) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(outRoot, `${stamp}-${arm}-${String(index + 1)}`);
  mkdirSync(dir, { recursive: true });
  // A private HOME per run: the app's build plugin and the daemon find each other (and the pairing
  // token) through it, and a shared one lets an earlier run's state answer for this one.
  const home = mkdtempSync(join(tmpdir(), 'bench-hva-home-'));
  const env = {
    ...process.env,
    HOME: home,
    // The browsers Playwright downloaded live under the real home; a private one has none, and the
    // daemon's lease pool cannot start a lane without them.
    PLAYWRIGHT_BROWSERS_PATH:
      process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), 'Library', 'Caches', 'ms-playwright'),
    RETICLE_PORT: String(daemonPort),
    RETICLE_TELEMETRY: '0',
    RETICLE_TOOL_LOG: join(dir, 'tools.jsonl'),
  };
  killPort(daemonPort);
  killPort(appPort);
  if (!flag('keep-flows'))
    rmSync(join(appDir, '.reticle', 'flows'), { recursive: true, force: true });

  const children = [];
  const start = (cmd, args, opts, log) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => out.push(d));
    child.on('exit', () => writeFileSync(join(dir, log), Buffer.concat(out)));
    children.push(child);
    alive.add(child);
    child.on('exit', () => alive.delete(child));
    return child;
  };
  // The daemon first: it writes the pairing token the app's build plugin reads when it starts.
  // In the app's folder, as a person starts it: an app with no project config keeps its flows
  // under the daemon's folder, and the private home is deleted after every run.
  start('node', [CLI, '_daemon', '--port', String(daemonPort)], { cwd: appDir, env }, 'daemon.log');
  await waitFor(
    () => existsSync(join(home, '.reticle', 'pairing-token')),
    CONNECT_TIMEOUT_MS,
    'the daemon',
  );
  start(
    join(appDir, 'node_modules/.bin/vite'),
    ['--port', String(appPort), '--strictPort'],
    { cwd: appDir, env },
    'app.log',
  );
  await waitFor(
    async () => (await fetch(appUrl).catch(() => undefined))?.ok === true,
    CONNECT_TIMEOUT_MS,
    'the app',
  );

  // A real browser tab, kept open for the agent to drive.
  const playwright = await import(
    pathToFileURL(createRequire(join(REPO, 'server/package.json')).resolve('playwright')).href
  );
  // CommonJS underneath, so the module's exports sit on `default` when imported.
  const { chromium } = playwright.chromium === undefined ? playwright.default : playwright;
  const browser = await chromium.launch({
    args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(appUrl);
  await sleep(8000);

  const mcp = {
    mcpServers: {
      reticle: { command: 'node', args: [CLI, 'mcp'], env: { ...pick(env), HOME: home } },
    },
  };
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify(mcp));
  const began = Date.now();
  const agent = spawnSync(
    'claude',
    [
      '-p',
      promptFor(),
      '--model',
      model,
      '--mcp-config',
      join(dir, 'mcp.json'),
      '--strict-mcp-config',
      '--allowedTools',
      'mcp__reticle',
      '--output-format',
      'stream-json',
      '--verbose',
    ],
    {
      cwd: home,
      env: process.env,
      encoding: 'utf8',
      timeout: AGENT_TIMEOUT_MS,
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  const wallMs = Date.now() - began;
  writeFileSync(join(dir, 'agent-stream.jsonl'), agent.stdout ?? '');
  await page.screenshot({ path: join(dir, 'end.png') }).catch(() => undefined);
  await browser.close();
  // Stopped and waited for: a daemon told to stop still writes its state on the way out, and
  // deleting its home under it failed the run.
  await Promise.all(
    children.map(
      (child) =>
        new Promise((done) => {
          if (child.exitCode !== null) return done(undefined);
          child.once('exit', () => done(undefined));
          child.kill();
          setTimeout(() => done(undefined), 10_000).unref();
        }),
    ),
  );
  if (existsSync(join(appDir, '.reticle', 'flows')))
    cpSync(join(appDir, '.reticle', 'flows'), join(dir, 'flows-after'), { recursive: true });
  writeFileSync(
    join(dir, 'metrics.json'),
    JSON.stringify({ arm, model, wallMs, ...metrics(dir) }, null, 2),
  );
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  console.log(`${arm} #${String(index + 1)} → ${dir}`);
}

/** The variables the MCP server needs, and nothing else from this shell. */
function pick(env) {
  const keep = [
    'RETICLE_PORT',
    'RETICLE_TELEMETRY',
    'RETICLE_TOOL_LOG',
    'RETICLE_CLOUD_URL',
    'RETICLE_API_KEY',
    'PATH',
  ];
  return Object.fromEntries(keep.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
}

/** What a run cost and how its checks went, read off the recorded calls. */
function metrics(dir) {
  const lines = (file) =>
    existsSync(join(dir, file))
      ? readFileSync(join(dir, file), 'utf8')
          .split('\n')
          .filter(Boolean)
          .flatMap((l) => {
            try {
              return [JSON.parse(l)];
            } catch {
              return [];
            }
          })
      : [];
  const result =
    lines('agent-stream.jsonl')
      .filter((d) => 'result' === d.type)
      .at(-1) ?? {};
  const tools = lines('tools.jsonl');
  const checks = { yes: 0, no: 0, undecided: 0, wrongGuesses: 0 };
  for (const t of tools) {
    if ('reticle_act_and_wait' !== t.tool || t.args?.until === undefined || t.result === undefined)
      continue;
    const v = t.result.verified;
    if ('yes' === v) checks.yes += 1;
    else if ('no' === v) checks.no += 1;
    else checks.undecided += 1;
    // A claimed request that never went over the wire: the drive's guess, not the app's defect.
    if ('no' === v && /no calls at all/.test(JSON.stringify(t.result.verdict ?? {})))
      checks.wrongGuesses += 1;
  }
  const explore = tools.find(
    (t) => 'reticle_verify' === t.tool && t.result?.driver !== undefined,
  )?.result;
  return {
    report: typeof result.result === 'string' ? result.result : '',
    agentCostUsd: result.total_cost_usd ?? null,
    agentTurns: result.num_turns ?? null,
    toolCalls: tools.length,
    harnessSteps: explore?.steps ?? null,
    harnessUsage: explore?.usage ?? null,
    savedFlows: explore?.savedFlows ?? [],
    rewroteFlows: explore?.rewroteFlows ?? [],
    checks,
  };
}

for (let i = 0; i < runs; i += 1) await oneRun(i);
