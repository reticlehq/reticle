#!/usr/bin/env node
// reticle-computer-use: joins a running application to the Reticle bridge, so the tools an agent
// has for a web page work on it. macOS only for now. Nothing is installed in the application.
//
//   reticle-computer-use --app <name> [--project <folder>] [--port <port>] [--watch <folder>]...
//                        [--no-electron-switch] [--background-only] [--no-hud]
//   reticle-computer-use --list                   (the applications that are open, as JSON)
//   reticle-computer-use --app <name> --doctor     (checks that it can work, and says what to do)
//
// The terminal needs Accessibility permission. The command stays open until you stop it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { nodeWorkspace } from '@reticlehq/cli-realm';

import {
  MacDriver,
  attachPlan,
  connectPeer,
  doctorReport,
  electronWarning,
  isElectron,
  joinedAnswer,
  macHud,
  pickApp,
} from '../dist/index.js';

const say = (line) => process.stderr.write(`${line}\n`);
const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);

const plan = attachPlan(process.argv.slice(2), process.env, homedir(), read);
const LIST = process.argv.includes('--list');
if ('error' in plan && !LIST) {
  say(plan.error);
  process.exit(2);
}
const native = fileURLToPath(new URL('../native/mac/', import.meta.url));
const helper = `${native}build/reticle-ax`;
const source = `${native}reticle-ax.swift`;

const quiet = (file, args) => {
  try {
    return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
};
/** The application by the name a person sees or the name of its process. Needs the helper. */
const findApp = (app) => {
  const listed = JSON.parse(quiet(helper, ['apps']) ?? '{}').apps;
  if (!Array.isArray(listed)) {
    // The helper did not answer: fall back to the name of the process.
    const found = Number((quiet('pgrep', ['-x', app]) ?? '').split('\n')[0]);
    return Number.isInteger(found) && found > 0
      ? { pid: found }
      : { error: `No application named ${app} is open.` };
  }
  return pickApp(app, listed);
};
/**
 * The helper, built when it is not there or when its source is newer. A helper from before an
 * update would answer in the old way, and nothing would say so.
 * ponytail: built on first use, which needs the Xcode command-line tools. Ship a signed helper
 * when this package is published.
 */
const hudProgram = `${native}build/reticle-hud`;
const buildOne = (program, from, stdio) => {
  if (existsSync(program) && statSync(program).mtimeMs >= statSync(from).mtimeMs) return true;
  mkdirSync(`${native}build`, { recursive: true });
  try {
    execFileSync('swiftc', ['-O', from, '-o', program], { stdio });
    return true;
  } catch {
    return false;
  }
};
const buildHelper = (stdio) => buildOne(helper, source, stdio);
const answers = (url) =>
  new Promise((resolve) => {
    const { hostname, port } = new URL(url);
    const socket = connect({ host: hostname, port: Number(port) });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });

if (LIST) {
  // For an agent: the names it can give to --app. Names only.
  if ('darwin' !== process.platform || !buildHelper('ignore')) {
    say(
      'reticle-computer-use runs on macOS only, and needs the Swift compiler: xcode-select --install',
    );
    process.exit(2);
  }
  const listed = JSON.parse(quiet(helper, ['apps']) ?? '{}').apps ?? [];
  process.stdout.write(
    `${JSON.stringify({ apps: listed.filter((app) => true === app.regular).map(({ name, process: program }) => ({ name, process: program })) })}\n`,
  );
  process.exit(0);
}

if (process.argv.includes('--doctor')) {
  const darwin = 'darwin' === process.platform;
  const compiler = darwin && buildHelper('ignore');
  const picked = darwin && compiler ? findApp(plan.app) : { error: undefined };
  const appPid = picked.pid;
  let trusted;
  let screenLocked;
  let windows;
  let windowsNotOnScreen;
  if (compiler) {
    // Any process will do to learn if the permission is there. The application's own, when open.
    const read = JSON.parse(quiet(helper, ['tree', String(appPid ?? process.pid)]) ?? '{}');
    trusted = 'not-trusted' !== read.error;
    screenLocked = 'screen-locked' === read.error;
    if (appPid !== undefined && read.tree !== undefined) {
      windows = read.tree.children.filter((child) => 'AXWindow' === child.role).length;
      windowsNotOnScreen = read.windowsNotOnScreen;
    }
  }
  const report = doctorReport({
    platform: process.platform,
    compiler,
    trusted,
    screenLocked,
    app: plan.app,
    appOpen: appPid !== undefined,
    appHint: picked.error,
    windows,
    windowsNotOnScreen,
    bridge: await answers(plan.url),
    token: plan.token !== undefined,
  });
  for (const line of report.lines) say(line);
  say(report.ready ? `\nReady. Run it again with no --doctor to join ${plan.app}.` : '');
  process.exit(report.ready ? 0 : 1);
}

if ('darwin' !== process.platform) {
  say('reticle-computer-use runs on macOS only for now.');
  process.exit(2);
}

if (!buildHelper('inherit')) {
  say('The helper could not be built. Run with --doctor to see why.');
  process.exit(1);
}
const picked = findApp(plan.app);
if (picked.pid === undefined) {
  say(`${picked.error} Run with --doctor to check the rest.`);
  process.exit(1);
}
const pid = picked.pid;

const warning = electronWarning(
  quiet('ps', ['-o', 'comm=', '-p', String(pid)]) ?? '',
  plan,
  existsSync,
);
if (warning !== undefined) {
  say(warning);
}
// The daemon ends when it is idle, and the next tool call starts it again. An agent that runs
// this command first found no daemon and gave up. So the command waits for the bridge for a time.
const WAIT_FOR_BRIDGE_MS = 30_000;
if (!(await answers(plan.url))) {
  say(`Waiting for the Reticle daemon at ${plan.url}. Call a Reticle tool, or run: reticle serve`);
  const until = Date.now() + WAIT_FOR_BRIDGE_MS;
  while (Date.now() < until && !(await answers(plan.url))) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
// The pointer and the window of the realm. Not having them is no reason to stop.
const hud =
  plan.hud && buildOne(hudProgram, `${native}hud.swift`, 'ignore')
    ? macHud(hudProgram, () => {
        // Stop in the window: leave the application, as Ctrl-C does.
        say('Stopped in the window of Reticle.');
        leave();
      })
    : undefined;
let leave = () => process.exit(0);
const sessionId = `cu-${plan.app}-${String(pid)}`.replace(/[^\w.-]/g, '-');
const peer = connectPeer({
  url: plan.url,
  ...(plan.token === undefined ? {} : { token: plan.token }),
  sessionId,
  projectId: plan.projectId ?? `cu-${plan.app}`.replace(/[^\w.-]/g, '-'),
  driver: new MacDriver({ helper, app: plan.app, pid }),
  ...(warning === undefined ? {} : { noEffectNote: warning }),
  foreground: plan.foreground,
  ...(hud === undefined ? {} : { hud }),
  ...(0 === plan.watch.length ? {} : { workspace: nodeWorkspace(plan.watch, { exclude: [] }) }),
  now: () => Date.now(),
});

try {
  await peer.ready;
} catch (error) {
  say(`Could not reach the bridge at ${plan.url}: ${String(error)}. Start it with: reticle serve`);
  process.exit(1);
}
// Only after the bridge answered: a command that ends before this leaves the application as it was.
const program = quiet('ps', ['-o', 'comm=', '-p', String(pid)]) ?? '';
const switched = plan.electronSwitch && isElectron(program, existsSync);
if (switched) {
  quiet(helper, ['web-tree', String(pid), 'on']);
}
say(`${plan.app} (${String(pid)}) is joined to ${plan.url}.`);
const joined = joinedAnswer(plan, sessionId, pid);
say(
  joined.needsSessionId
    ? `Give this on each tool call: sessionId "${sessionId}". Stop with Ctrl-C.`
    : 'The session is in the project you named. When a browser tab of that project is connected too, give the sessionId on each call. Stop with Ctrl-C.',
);
// One line for an agent that started this command: what was joined, and what to call next.
process.stdout.write(`${JSON.stringify(joined)}\n`);
if (plan.token === undefined) {
  say(
    'No pairing token was found. The session is joined, but a file or a setting that changes with nothing else is then not proof: the bridge cannot tell this command from a page. Start the daemon with `reticle serve`, which writes the token.',
  );
}
const stop = () => {
  hud?.close();
  if (switched) {
    quiet(helper, ['web-tree', String(pid), 'off']);
  }
  peer.close();
  process.exit(0);
};
leave = stop;
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
// The terminal was closed.
process.on('SIGHUP', stop);
// The heartbeat timer does not hold the process open, so this one does.
setInterval(() => {}, 60_000);
