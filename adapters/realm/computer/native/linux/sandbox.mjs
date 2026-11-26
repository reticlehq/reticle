// `reticle-computer --sandbox linux`: a Linux desktop of its own for the agent, in a container.
// The application runs on an X screen in memory, and joins the daemon of this machine. The agent
// works there; the person's screen, pointer and keyboard are not used at all.
//
//   reticle-computer --sandbox linux --app <name> --open "<command>" [--port <port>]
//   reticle-computer --sandbox stop
//
// Needs Docker. The image is built once from native/linux/Dockerfile. The package is mounted into
// the container read-only, at the same path, so the container runs this same version.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const IMAGE = 'reticle-computer-linux:1';
const LABEL = 'reticle.computer.sandbox';
const here = fileURLToPath(new URL('.', import.meta.url));
const pkg = realpathSync(join(here, '..', '..'));
const say = (line) => process.stdout.write(`${line}\n`);
const docker = (args, options = {}) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });

/** The longest folder that holds both paths. */
function common(a, b) {
  const x = a.split(sep);
  const y = b.split(sep);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n += 1;
  return x.slice(0, n).join(sep) || sep;
}

export async function sandbox(argv) {
  const valueOf = (flag) => {
    const at = argv.indexOf(flag);
    return at < 0 ? undefined : argv[at + 1];
  };
  if (0 !== spawnSync('docker', ['info'], { stdio: 'ignore' }).status) {
    say('The sandbox needs Docker, and Docker is not running. Start Docker, and try again.');
    return 2;
  }
  if ('stop' === valueOf('--sandbox')) {
    const ids = docker(['ps', '-q', '--filter', `label=${LABEL}`])
      .split('\n')
      .filter(Boolean);
    for (const id of ids) docker(['kill', id]);
    say(`Stopped ${String(ids.length)} sandbox(es).`);
    return 0;
  }
  if ('linux' !== valueOf('--sandbox')) {
    say('The sandbox is Linux: --sandbox linux. Or --sandbox stop.');
    return 2;
  }
  const app = valueOf('--app');
  const open = valueOf('--open');
  if (app === undefined || open === undefined) {
    say('Name the application and how to start it: --app <name> --open "<command>".');
    return 2;
  }
  if (0 !== spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status) {
    say(`Building ${IMAGE} once, from ${join(here, 'Dockerfile')}. This takes a few minutes.`);
    docker(['build', '-t', IMAGE, '-f', join(here, 'Dockerfile'), here], { stdio: 'inherit' });
  }
  // The package and its dependencies, at the same paths, read-only.
  const core = realpathSync(createRequire(join(pkg, 'package.json')).resolve('@reticlehq/core'));
  const mount = common(pkg, dirname(core));
  const port = valueOf('--port') ?? process.env['RETICLE_PORT'] ?? '4400';
  let token = process.env['RETICLE_TOKEN'];
  try {
    token ??= readFileSync(join(homedir(), '.reticle', 'pairing-token'), 'utf8').trim();
  } catch {
    // ponytail: no token file; the bridge then refuses the dial, and the command says so.
  }
  // Docker Desktop reaches this machine's localhost as host.docker.internal. Docker on Linux
  // shares the network of the machine instead.
  const linux = 'linux' === process.platform;
  const host = linux ? '127.0.0.1' : 'host.docker.internal';
  const name = `reticle-computer-${app.replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
  const attach = join(pkg, 'bin', 'attach.mjs');
  const inside = `${open} & sleep 3; exec node '${attach}' --app '${app}' --host ${host} --port ${port} --no-hud`;
  docker([
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '--label',
    LABEL,
    ...(linux ? ['--network', 'host'] : []),
    ...(token === undefined ? [] : ['-e', `RETICLE_TOKEN=${token}`]),
    '-v',
    `${mount}:${mount}:ro`,
    IMAGE,
    'dbus-run-session',
    '--',
    'xvfb-run',
    '-a',
    '-s',
    '-screen 0 1280x800x24',
    'sh',
    '-c',
    inside,
  ]);
  // The joined line of the command in the container: it has the sessionId to give each call.
  for (let i = 0; i < 60; i += 1) {
    await sleep(1000);
    const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8' });
    const joined = `${logs.stdout}${logs.stderr}`
      .split('\n')
      .find((l) => l.startsWith('{"joined"'));
    if (joined !== undefined) {
      say(joined);
      say(
        `It runs in the container ${name}, on a screen of its own. Stop it: reticle-computer --sandbox stop`,
      );
      return 0;
    }
    if (0 !== spawnSync('docker', ['inspect', name], { stdio: 'ignore' }).status) {
      say(`The sandbox ended before ${app} joined. Its output:\n${logs.stdout}${logs.stderr}`);
      return 1;
    }
  }
  say(`${app} did not join in 60 seconds. See: docker logs ${name}`);
  return 1;
}
