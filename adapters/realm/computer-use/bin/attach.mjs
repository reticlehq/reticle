#!/usr/bin/env node
// reticle-computer-use: joins a running application to the Reticle bridge, so the tools an agent
// has for a web page work on it. macOS only for now. Nothing is installed in the application.
//
//   reticle-computer-use --app <name> [--project <folder>] [--port <port>] [--watch <folder>]...
//
// The terminal needs Accessibility permission. The command stays open until you stop it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { nodeWorkspace } from '@reticlehq/cli-realm';

import { MacDriver, attachPlan, connectPeer } from '../dist/index.js';

const say = (line) => process.stderr.write(`${line}\n`);
const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);

const plan = attachPlan(process.argv.slice(2), process.env, homedir(), read);
if ('error' in plan) {
  say(plan.error);
  process.exit(2);
}
if ('darwin' !== process.platform) {
  say('reticle-computer-use runs on macOS only for now.');
  process.exit(2);
}

let pid;
try {
  pid = Number(execFileSync('pgrep', ['-x', plan.app], { encoding: 'utf8' }).split('\n')[0]);
} catch {
  say(`No application named ${plan.app} is open.`);
  process.exit(1);
}

// ponytail: the helper is compiled on first use, which needs the Xcode command-line tools.
// Ship a signed helper when this package is published.
const native = fileURLToPath(new URL('../native/mac/', import.meta.url));
const helper = `${native}build/reticle-ax`;
if (!existsSync(helper)) {
  mkdirSync(`${native}build`, { recursive: true });
  execFileSync('swiftc', ['-O', `${native}reticle-ax.swift`, '-o', helper], { stdio: 'inherit' });
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
