import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import type { ToolDeps } from './tool-kit.js';
import { closeOpenedBy, closeRealm, openRealm, type RealmIo } from './realm-open.js';

// An agent could not open the realm where the next proof lives: the computer realm started only
// when the agent ran `reticle-computer` by hand, and nothing closed what it opened (#2557).

interface FakeSession {
  id: string;
  url: string;
}

function fakeDeps(attachId: string, sessions: FakeSession[], parked: string[] = []): ToolDeps {
  return {
    attachId,
    bridgePort: 14500,
    nonces: { mint: () => ({ nonce: 'n1', expiresAt: 0 }) },
    sessions: {
      all: () => sessions,
      get: (id: string) => sessions.find((s) => s.id === id),
      park: (s: FakeSession) => {
        parked.push(s.id);
        sessions.splice(sessions.indexOf(s), 1);
      },
    },
  } as unknown as ToolDeps;
}

/** A child process that prints the computer realm's joined line, then waits to be killed. */
function fakeComputer(line: string | undefined, killed: string[]) {
  return (cmd: string, args: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (signal?: string) => boolean;
      exitCode: number | null;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = (signal?: string) => {
      killed.push(`${signal ?? 'SIGTERM'} ${[cmd, ...args].join(' ')}`);
      child.exitCode = 0;
      setTimeout(() => child.emit('exit', 0, signal ?? 'SIGTERM'), 5);
      return true;
    };
    setTimeout(() => {
      if (line === undefined) {
        child.stderr.write('no application is named Nope\n');
        child.exitCode = 1;
        child.emit('exit', 1, null);
        return;
      }
      child.stdout.write(`${line}\n`);
    }, 10);
    return child as never;
  };
}

describe('open and close a realm', () => {
  const joined = (id: string) => JSON.stringify({ joined: true, sessionId: id, app: 'Mail' });
  // The person lists the apps an agent may open, in their own file.
  const io = (
    spawn: NonNullable<RealmIo['spawn']>,
    // null: the person has no file at all.
    settings: string | null = '{"open":["Mail","Notes","Maps","Nope"]}',
  ): RealmIo => ({
    spawn,
    computerCommand: () => ({ cmd: 'reticle-computer', args: [] }),
    ownerSettings: () => settings ?? undefined,
  });

  it('opens a desktop application as a session, and answers with its sessionId', async () => {
    const sessions: FakeSession[] = [];
    const killed: string[] = [];
    const deps = fakeDeps('agent-a', sessions);
    const spawn = fakeComputer(joined('cu-mail-1'), killed);
    const answer = await openRealm(
      deps,
      { realm: 'computer', app: 'Mail', launch: true },
      io(spawn),
    );
    expect(answer).toMatchObject({ ok: true, realm: 'computer', sessionId: 'cu-mail-1' });
    // The command joined the app named, and started it when asked.
    await closeRealm(deps, { sessionId: 'cu-mail-1' });
    expect(killed[0]).toContain('reticle-computer --app Mail --open');
  });

  it('says why when the application cannot be joined, and keeps nothing open', async () => {
    const deps = fakeDeps('agent-a', []);
    const answer = await openRealm(
      deps,
      { realm: 'computer', app: 'Nope' },
      io(fakeComputer(undefined, [])),
    );
    expect(answer).toMatchObject({ ok: false });
    expect(String(answer['error'])).toContain('no application is named Nope');
  });

  it('closes a desktop session it opened by ending the process: the process joins again after a socket close', async () => {
    const killed: string[] = [];
    const deps = fakeDeps('agent-a', []);
    await openRealm(
      deps,
      { realm: 'computer', app: 'Mail' },
      io(fakeComputer(joined('cu-mail-2'), killed)),
    );
    expect(await closeRealm(deps, { sessionId: 'cu-mail-2' })).toMatchObject({
      ok: true,
      closed: 'cu-mail-2',
    });
    expect(killed).toHaveLength(1);
    // Closed once: a second close has nothing to close.
    expect(await closeRealm(deps, { sessionId: 'cu-mail-2' })).toMatchObject({ ok: false });
  });

  it('refuses to close a session another agent opened, or one that open did not open', async () => {
    const sessions: FakeSession[] = [{ id: 's-page', url: 'http://localhost:5173/' }];
    const killed: string[] = [];
    const a = fakeDeps('agent-a', sessions);
    await openRealm(
      a,
      { realm: 'computer', app: 'Mail' },
      io(fakeComputer(joined('cu-mail-3'), killed)),
    );
    const b = fakeDeps('agent-b', sessions);
    expect(await closeRealm(b, { sessionId: 'cu-mail-3' })).toMatchObject({ ok: false });
    expect(String((await closeRealm(b, { sessionId: 's-page' }))['error'])).toContain('end');
    expect(killed).toEqual([]);
    await closeRealm(a, { sessionId: 'cu-mail-3' });
  });

  it('opens a tab of the person’s browser through the attach, and closes it by parking the session', async () => {
    const sessions: FakeSession[] = [];
    const parked: string[] = [];
    const deps = fakeDeps('agent-a', sessions, parked);
    const answer = await openRealm(
      deps,
      { realm: 'browser', match: 'app.example.com', timeoutMs: 2000 },
      {
        attach: {
          bundle: 'READER',
          attach: () => {
            setTimeout(() => sessions.push({ id: 'tab-1', url: 'https://app.example.com/' }), 20);
            return Promise.resolve({ url: 'https://app.example.com/', title: 'Example' });
          },
        },
        detach: () => Promise.resolve(1),
      },
    );
    expect(answer).toMatchObject({ ok: true, realm: 'browser', sessionId: 'tab-1' });
    expect(await closeRealm(deps, { sessionId: 'tab-1' })).toMatchObject({ ok: true });
    expect(parked).toEqual(['tab-1']);
  });

  it('closes every realm an agent opened when that agent leaves', async () => {
    const killed: string[] = [];
    const deps = fakeDeps('agent-c', []);
    await openRealm(
      deps,
      { realm: 'computer', app: 'Mail' },
      io(fakeComputer(joined('cu-c-1'), killed)),
    );
    await openRealm(
      deps,
      { realm: 'computer', app: 'Notes' },
      io(fakeComputer(joined('cu-c-2'), killed)),
    );
    const other = fakeDeps('agent-d', []);
    await openRealm(
      other,
      { realm: 'computer', app: 'Maps' },
      io(fakeComputer(joined('cu-d-1'), killed)),
    );
    expect((await closeOpenedBy('agent-c')).sort()).toEqual(['cu-c-1', 'cu-c-2']);
    expect(killed).toHaveLength(2);
    await closeOpenedBy('agent-d');
  });

  // A tool call is not a terminal command, so the agent's own approval prompt does not ask the
  // person first. Opening an app is allowed only for an app the person listed in ~/.reticle/computer.json.
  it('refuses an app the person did not list, and starts nothing', async () => {
    const killed: string[] = [];
    let spawned = 0;
    const spawn: NonNullable<RealmIo['spawn']> = (cmd, args) => {
      spawned += 1;
      return fakeComputer(joined('cu-x'), killed)(cmd, args);
    };
    const deps = fakeDeps('agent-a', []);
    for (const settings of [null, '{}', '{"open":["Notes"]}', 'not json']) {
      const answer = await openRealm(
        deps,
        { realm: 'computer', app: 'Terminal' },
        io(spawn, settings),
      );
      expect(answer).toMatchObject({ ok: false });
      expect(String(answer['error'])).toContain('computer.json');
    }
    expect(spawned).toBe(0);
  });

  it('matches a listed app without regard to case', async () => {
    const killed: string[] = [];
    const deps = fakeDeps('agent-a', []);
    const answer = await openRealm(
      deps,
      { realm: 'computer', app: 'mail' },
      io(fakeComputer(joined('cu-mail-9'), killed)),
    );
    expect(answer).toMatchObject({ ok: true });
    await closeRealm(deps, { sessionId: 'cu-mail-9' });
  });

  it('refuses an unknown realm and a computer realm with no app', async () => {
    const deps = fakeDeps('agent-a', []);
    expect(await openRealm(deps, { realm: 'terminal' })).toMatchObject({ ok: false });
    expect(await openRealm(deps, { realm: 'computer' })).toMatchObject({ ok: false });
  });
});
