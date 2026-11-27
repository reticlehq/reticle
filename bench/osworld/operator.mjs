// The operator of the OSWorld Reticle agent: a real bridge, Reticle's computer joined to the
// applications of an OSWorld guest, and HTTP on 4498 that the agent calls.
//
// Reticle's realm runs here, on the host. Only its Linux helper (reticle-atspi.py) runs in the
// guest: each helper command goes to the guest's own OSWorld server (POST /execute on port 5000)
// as `python3 reticle-atspi.py <command>`. So the guest needs nothing that OSWorld's stock image
// does not have, except xdotool, which `/setup` installs.
//
//   POST /setup { guest }        puts the helper in the guest and checks what it needs.
//                                `guest` is the guest server's base URL, e.g. http://localhost:5000.
//   GET  /apps                   the guest's applications that have a window: { apps: [...] }
//   POST /join  { pid, keep? }   joins one application, answers { sessionId }. Without `keep`
//                                it first closes the sessions of the last task.
//   POST /tool  { name, args }   runs one tool of the agent's surface, answers its result.
//
//   node bench/osworld/operator.mjs
//
// Build the repository first (pnpm build).
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { MacDriver, connectPeer } from '../../adapters/realm/computer/dist/index.js';
import { Bridge } from '../../server/dist/portal/bridge/bridge.js';
import {
  callTool,
  makeDeps,
  waitUntil,
} from '../../server/dist/portal/bridge/bridge.test-harness.js';

const PORT = Number(process.env.OSWORLD_OPERATOR_PORT ?? 4498);
const TOKEN = 'osworld-bench';
const HELPER_IN_GUEST = '/tmp/reticle-atspi.py';
// The sudo password of OSWorld's docker, vmware and virtualbox guests (OSWorld README, FAQ).
const GUEST_PASSWORD = process.env.OSWORLD_GUEST_PASSWORD ?? 'password';
const helperSource = readFileSync(
  fileURLToPath(
    new URL('../../adapters/realm/computer/native/linux/reticle-atspi.py', import.meta.url),
  ),
);

let guest;

/** Run a command in the guest through its OSWorld server. */
async function guestRun(command, shell = false) {
  const response = await fetch(`${guest}/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, shell }),
  });
  const answer = await response.json();
  if ('success' !== answer.status) {
    throw new Error(`the guest did not run the command: ${String(answer.message)}`);
  }
  return answer;
}

/** The driver's helper, in the guest. One process for each command: the guest has no stream. */
async function guestHelper(_file, args) {
  const answer = await guestRun(['python3', HELPER_IN_GUEST, ...args]);
  const line = answer.output.trim().split('\n').pop() ?? '';
  return '' === line ? JSON.stringify({ error: answer.error.trim() || 'no answer' }) : line;
}

async function setup(input) {
  guest = String(input.guest).replace(/\/$/, '');
  const encoded = helperSource.toString('base64');
  await guestRun([
    'python3',
    '-c',
    `import base64;open(${JSON.stringify(HELPER_IN_GUEST)},'wb').write(base64.b64decode(${JSON.stringify(encoded)}))`,
  ]);
  const checks = {
    gi: await guestRun([
      'python3',
      '-c',
      "import gi; gi.require_version('Atspi','2.0'); gi.require_version('Gdk','3.0'); from gi.repository import Atspi, Gdk",
    ]),
    xdotool: await guestRun(['which', 'xdotool']),
  };
  if (0 !== checks.xdotool.returncode) {
    checks.install = await guestRun(
      `echo ${GUEST_PASSWORD} | sudo -S apt-get install -y -qq xdotool`,
      true,
    );
    checks.xdotool = await guestRun(['which', 'xdotool']);
  }
  return {
    ok: 0 === checks.gi.returncode && 0 === checks.xdotool.returncode,
    gi: 0 === checks.gi.returncode ? 'ok' : checks.gi.error.trim(),
    xdotool: 0 === checks.xdotool.returncode ? 'ok' : 'missing',
  };
}

const bridge = new Bridge({ port: 0, token: TOKEN });
const bridgePort = await bridge.ready;
const deps = makeDeps(bridge);
const peers = new Map();
let joined = 0;

async function leaveAll() {
  for (const one of peers.values()) {
    one.close();
  }
  peers.clear();
  await waitUntil(() => 0 === bridge.sessions.count());
}

async function apps() {
  return JSON.parse(await guestHelper('', ['apps']));
}

async function joinApp(pid, keep) {
  if (true !== keep) {
    await leaveAll();
  } else if (peers.has(pid)) {
    return { sessionId: peers.get(pid).sessionId };
  }
  const found = (await apps()).apps?.find((one) => pid === one.pid);
  if (found === undefined) {
    throw new Error(`no application with process ${String(pid)} is open in the guest`);
  }
  joined += 1;
  const sessionId = `osworld-${String(joined)}`;
  const peer = connectPeer({
    url: `ws://localhost:${String(bridgePort)}/reticle`,
    token: TOKEN,
    sessionId,
    projectId: 'osworld-bench',
    driver: new MacDriver({ helper: HELPER_IN_GUEST, app: found.name, pid, run: guestHelper }),
    now: () => Date.now(),
  });
  await peer.ready;
  peers.set(pid, Object.assign(peer, { sessionId }));
  await waitUntil(() => peers.size === bridge.sessions.count());
  return { sessionId, app: found.name };
}

const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
  }
  const input = JSON.parse(body || '{}');
  let answer;
  try {
    if ('/setup' === request.url) {
      answer = await setup(input);
    } else if ('/apps' === request.url) {
      answer = await apps();
    } else if ('/join' === request.url) {
      answer = await joinApp(Number(input.pid), input.keep);
    } else if ('/tool' === request.url) {
      answer = await callTool(deps, input.name, input.args ?? {});
    } else {
      answer = { error: `no route ${String(request.url)}` };
    }
  } catch (error) {
    answer = { ok: false, error: String(error.message ?? error) };
  }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(answer));
});
server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`osworld operator: http://127.0.0.1:${String(PORT)}\n`);
});
