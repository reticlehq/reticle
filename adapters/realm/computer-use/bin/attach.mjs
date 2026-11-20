#!/usr/bin/env node
// reticle-computer-use: joins a running application to the Reticle bridge, so the tools an agent
// has for a web page work on it. macOS only for now. Nothing is installed in the application.
//
//   reticle-computer-use --app <name> [--project <folder>] [--port <port>] [--watch <folder>]...
//   reticle-computer-use --app <name> --doctor     (checks that it can work, and says what to do)
//
// The terminal needs Accessibility permission. The command stays open until you stop it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { nodeWorkspace } from '@reticlehq/cli-realm';

import { MacDriver, attachPlan, connectPeer, doctorReport } from '../dist/index.js';

const say = (line) => process.stderr.write(`${line}\n`);
const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);

const plan = attachPlan(process.argv.slice(2), process.env, homedir(), read);
if ('error' in plan) {
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
const pidOf = (app) => {
  const found = Number((quiet('pgrep', ['-x', app]) ?? '').split('\n')[0]);
  return Number.isInteger(found) && found > 0 ? found : undefined;
};
/**
 * The helper, built when it is not there or when its source is newer. A helper from before an
 * update would answer in the old way, and nothing would say so.
 * ponytail: built on first use, which needs the Xcode command-line tools. Ship a signed helper
 * when this package is published.
 */
const buildHelper = (stdio) => {
  if (existsSync(helper) && statSync(helper).mtimeMs >= statSync(source).mtimeMs) return true;
  mkdirSync(`${native}build`, { recursive: true });
  try {
    execFileSync('swiftc', ['-O', source, '-o', helper], { stdio });
    return true;
  } catch {
    return false;
  }
};
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

if (process.argv.includes('--doctor')) {
  const darwin = 'darwin' === process.platform;
  const compiler = darwin && buildHelper('ignore');
  const appPid = darwin ? pidOf(plan.app) : undefined;
  let trusted;
  let windows;
  let windowsNotOnScreen;
  if (compiler) {
    // Any process will do to learn if the permission is there. The application's own, when open.
    const read = JSON.parse(quiet(helper, ['tree', String(appPid ?? process.pid)]) ?? '{}');
    trusted = 'not-trusted' !== read.error;
    if (appPid !== undefined && read.tree !== undefined) {
      windows = read.tree.children.filter((child) => 'AXWindow' === child.role).length;
      windowsNotOnScreen = read.windowsNotOnScreen;
    }
  }
  const report = doctorReport({
    platform: process.platform,
    compiler,
    trusted,
    app: plan.app,
    appOpen: appPid !== undefined,
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

const pid = pidOf(plan.app);
if (pid === undefined) {
  say(`No application named ${plan.app} is open. Run with --doctor to check the rest.`);
  process.exit(1);
}
if (!buildHelper('inherit')) {
  say('The helper could not be built. Run with --doctor to see why.');
  process.exit(1);
}

const sessionId = `cu-${plan.app}-${String(pid)}`.replace(/[^\w.-]/g, '-');
const peer = connectPeer({
  url: plan.url,
  ...(plan.token === undefined ? {} : { token: plan.token }),
  sessionId,
  projectId: plan.projectId ?? `cu-${plan.app}`.replace(/[^\w.-]/g, '-'),
  driver: new MacDriver({ helper, app: plan.app, pid }),
  ...(0 === plan.watch.length ? {} : { workspace: nodeWorkspace(plan.watch, { exclude: [] }) }),
  now: () => Date.now(),
});

try {
  await peer.ready;
} catch (error) {
  say(`Could not reach the bridge at ${plan.url}: ${String(error)}. Start it with: reticle serve`);
  process.exit(1);
}
say(`${plan.app} (${String(pid)}) is joined to ${plan.url}.`);
say(`Give this on each tool call: sessionId "${sessionId}". Stop with Ctrl-C.`);
if (plan.projectId === undefined) {
  say(
    'No project: the runs and flows of this session stay on this machine and do not reach the dashboard. Give --project <folder> with the folder of the application that has a .reticle.json.',
  );
}
const stop = () => {
  peer.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
// The heartbeat timer does not hold the process open, so this one does.
setInterval(() => {}, 60_000);
