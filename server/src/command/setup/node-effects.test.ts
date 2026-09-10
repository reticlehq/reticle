import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  alreadyWired,
  binaryExists,
  flowsSaved,
  OwnedDevServer,
  probePage,
} from './node-effects.js';

const isWindows = 'win32' === process.platform;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Who is LISTENING on this port right now, as a pid list — empty when nobody is. */
const holdersOf = (port: number): string =>
  spawnSync('sh', ['-c', `lsof -ti:${port} -sTCP:LISTEN || true`], {
    encoding: 'utf8',
  }).stdout.trim();

/**
 * Wait until the port is held (or released), rather than sleeping a guess.
 *
 * These tests spawn a real shell, which spawns a real node, which then binds. A fixed 1,200ms for
 * all three was fine on a developer's machine and not on a loaded runner: when it was not enough
 * the fixture had simply not come up yet, and the assertion failed as `expected '' not to be ''` —
 * a handover reported as broken because the machine was busy. That is the shape CLAUDE.md rules out
 * under *Timing assertions are a bug*, and it has now cost three unrelated PRs a red CI.
 *
 * Polling is strictly better here: it returns as soon as the state is real, so the fast path is
 * faster than the sleep it replaces, and the ceiling only matters when something is genuinely wrong.
 */
async function waitForPort(port: number, want: 'held' | 'free'): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const held = holdersOf(port);
    if (('held' === want) === ('' !== held)) return held;
    if (Date.now() >= deadline) return held;
    await sleep(50);
  }
}

describe('the dev server this process owns', () => {
  // The promise: stopped on every ending except success. An interrupted run used to leave one
  // listening indefinitely, holding a port nobody could account for.
  it.skipIf(isWindows)(
    'stops what it started, including what that started',
    async () => {
      const port = 59_231;
      const server = new OwnedDevServer();
      // A shell that spawns node: the port belongs to the GRANDCHILD, which is the shape that makes
      // killing only the process we hold insufficient.
      server.start(
        `node -e "require('http').createServer((q,r)=>r.end('hi')).listen(${port},'127.0.0.1')"`,
        process.cwd(),
        {},
      );
      expect(await waitForPort(port, 'held'), 'the fixture server never came up').not.toBe('');
      server.stop();
      expect(await waitForPort(port, 'free'), 'stopping left the port held by an orphan').toBe('');
    },
    15_000,
  );

  it.skipIf(isWindows)(
    'leaves it running once handed over, because that is the deliverable',
    async () => {
      const port = 59_232;
      const server = new OwnedDevServer();
      server.start(
        `node -e "require('http').createServer((q,r)=>r.end('hi')).listen(${port},'127.0.0.1')"`,
        process.cwd(),
        {},
      );
      expect(await waitForPort(port, 'held'), 'the fixture server never came up').not.toBe('');
      server.handOver();
      server.stop();
      // A real pause, not a poll: this asserts the server is STILL there, so it has to be given a
      // chance to die first. Polling for "still held" would pass on its first tick and prove nothing.
      await sleep(400);
      const survivors = holdersOf(port);
      // Killed BEFORE the assertion, so a failure cannot leak the listener this test deliberately
      // kept alive: an assertion that throws would skip the cleanup underneath it, and the next run
      // would find 59232 held and fail for a reason belonging to this one.
      for (const pid of survivors.split('\n').filter(Boolean)) {
        process.kill(Number(pid), 'SIGKILL');
      }
      expect(survivors, 'a handed-over server must survive').not.toBe('');
    },
    15_000,
  );

  it('reports what the server printed, and how long it has been quiet', async () => {
    const server = new OwnedDevServer();
    server.start('echo "  Local: http://localhost:1234"', process.cwd(), {});
    await sleep(600);
    expect(server.output()).toContain('http://localhost:1234');
    expect(server.quietForMs()).toBeGreaterThanOrEqual(0);
    server.stop();
  }, 10_000);

  it('has nothing to stop when nothing was started', () => {
    expect(() => new OwnedDevServer().stop()).not.toThrow();
  });
});

describe('probing the page', () => {
  it('reports nothing answering as not served', async () => {
    expect(await probePage('http://127.0.0.1:59233/')).toMatchObject({ served: false });
  });
});

describe('reading the project', () => {
  it('finds a saved flow in any of the roots it is given', () => {
    const root = mkdtempSync(join(tmpdir(), 'flows-'));
    mkdirSync(join(root, 'apps', 'web', '.reticle', 'flows'), { recursive: true });
    writeFileSync(join(root, 'apps', 'web', '.reticle', 'flows', 'a.json'), '{}');
    // In a monorepo `.reticle/` sits at the APP root; looking only where setup was invoked reported
    // "no verdict" for a run whose drive had saved a flow and said so.
    expect(flowsSaved([root])).toBe(false);
    expect(flowsSaved([root, join(root, 'apps', 'web')])).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('knows an unwired project from a wired one', () => {
    const root = mkdtempSync(join(tmpdir(), 'wired-'));
    expect(alreadyWired(root)).toBe(false);
    writeFileSync(join(root, '.reticle.json'), '{}');
    expect(alreadyWired(root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('tells a binary that exists from one that does not', () => {
    expect(binaryExists('node')).toBe(true);
    expect(binaryExists('definitely-not-a-real-binary-xyz')).toBe(false);
  });
});

describe('handing the dev server over', () => {
  // The bug this pins produced no error and no failing assertion: `init` printed "setup complete"
  // and then sat there, because the child's stdout pipe still belonged to this process and an open
  // pipe holds the event loop by itself. The only visible symptom was a non-zero exit on a run that
  // had succeeded, which is why it survived every gate except the one that reads exit codes.
  it('lets the process exit, rather than holding it open on the child’s pipes', () => {
    const script = `
      import { OwnedDevServer } from '${pathToFileURL(join(process.cwd(), 'dist/command/setup/node-effects.js')).href}';
      const server = new OwnedDevServer();
      // A stand-in dev server: long-lived and chatty, so its pipes are genuinely active.
      server.start('node -e "setInterval(() => console.log(1), 50)"', process.cwd(), {});
      setTimeout(() => {
        console.log(JSON.stringify({ pid: server.pid() }));
        server.handOver();
      }, 300);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    // A timeout kill is exactly the failure: the process never ran out of work to do.
    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
    const reported: unknown = JSON.parse(child.stdout.trim().split('\n')[0] ?? '{}');
    const pid =
      'object' === typeof reported && null !== reported && 'pid' in reported
        ? Number((reported as { pid?: unknown }).pid ?? 0)
        : 0;
    if (0 < pid) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        /* the handed-over server is the point; cleaning it up is best effort */
      }
    }
  });
});
