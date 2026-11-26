// The operator of cu-bench.mjs: a real bridge, Reticle's computer joined to one application at a
// time, and HTTP on 4499 that the bench calls.
//
//   POST /join  { app }          joins the open application by its name, answers { sessionId }
//   POST /tool  { name, args }   runs one tool of the agent's surface, answers its result
//
//   node bench/computer/operator.mjs
//
// macOS only. Build the repository first (pnpm build). It needs the Accessibility and Screen
// Recording permissions for the terminal that runs it.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MacDriver, connectPeer } from '../../adapters/realm/computer/dist/index.js';
import { Bridge } from '../../server/dist/portal/bridge/bridge.js';
import {
  callTool,
  makeDeps,
  waitUntil,
} from '../../server/dist/portal/bridge/bridge.test-harness.js';

const PORT = 4499;
const TOKEN = 'cu-bench';
const root = fileURLToPath(new URL('../..', import.meta.url));
const native = join(root, 'adapters/realm/computer/native/mac');
const helper = join(native, 'build/reticle-ax');
execFileSync('swiftc', ['-O', join(native, 'reticle-ax.swift'), '-o', helper], { stdio: 'ignore' });

const bridge = new Bridge({ port: 0, token: TOKEN });
const bridgePort = await bridge.ready;
const deps = makeDeps(bridge);
let peer;
let joined = 0;

async function joinApp(app) {
  if (peer !== undefined) {
    peer.close();
    await waitUntil(() => 0 === bridge.sessions.count());
  }
  const listed = JSON.parse(execFileSync(helper, ['apps'], { encoding: 'utf8' })).apps;
  const found = listed.find((one) => app === one.name || app === one.process);
  if (found === undefined) {
    throw new Error(`${app} is not open`);
  }
  joined += 1;
  const sessionId = `cu-bench-${String(joined)}`;
  peer = connectPeer({
    url: `ws://localhost:${String(bridgePort)}/reticle`,
    token: TOKEN,
    sessionId,
    projectId: 'cu-bench',
    driver: new MacDriver({ helper, app: found.name, pid: found.pid }),
    now: () => Date.now(),
  });
  await peer.ready;
  await waitUntil(() => 1 === bridge.sessions.count());
  return { sessionId };
}

const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
  }
  const input = JSON.parse(body || '{}');
  let answer;
  try {
    if ('/join' === request.url) {
      answer = await joinApp(input.app);
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
  process.stderr.write(`cu-bench operator: http://127.0.0.1:${String(PORT)}\n`);
});
