import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveDaemonForProject,
  adoptable,
  daemonInsideProject,
  relocationReason,
  resolveMcpPort,
  projectlessNote,
  projectDaemonsElsewhere,
  daemonsServingProjectElsewhere,
  splitBrainNote,
  wrongDaemonNote,
} from './daemon-resolve.js';
import { removeTempDirSync } from '@/machine/temp-dir.test-helpers.js';

/**
 * Which daemon does THIS project belong to?
 *
 * The system used to answer that question two incompatible ways. Build plugins asked the registry by
 * projectId; the CLI and the MCP proxy asked a port number — `envPort ?? projectPort ?? 4400` — and
 * then attached to whatever happened to own it. So every project on a machine funnelled into one
 * daemon, whose recorded identity was whichever project won the race to the port, and the registry
 * entry became a lie the moment a second project attached.
 *
 * It worked anyway, by luck: everyone defaulted to the same number, so everyone found each other.
 * The luck runs out the moment a daemon is anywhere but 4400 — and it takes the whole machine's
 * agents with it, because one kill on that port drops all of them at once.
 *
 * These pin the resolver that makes the registry the single answer on both sides.
 */
const live = (): boolean => true;
const dead = (): boolean => false;

describe('resolveDaemonForProject', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      removeTempDirSync(d);
    }
  });

  function home(entries: readonly Record<string, unknown>[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-reg-'));
    dirs.push(dir);
    for (const e of entries) {
      writeFileSync(join(dir, `daemon-${String(e['port'])}.json`), JSON.stringify(e));
    }
    return dir;
  }

  it('finds this project’s daemon wherever it is listening', () => {
    const dir = home([{ port: 47311, pid: 1, cwd: '/a', startedAt: 1, projectId: 'shop' }]);
    expect(resolveDaemonForProject('shop', dir, live)).toBe(47311);
  });

  /**
   * #2341: the project moved from :4441 to :4442 and both daemons are alive. The page dials the
   * configured port, so that daemon is the project's own, and `status` must not call it a stranger.
   */
  it('takes the configured port over a lower port the project used before', () => {
    const dir = home([
      { port: 4441, pid: 1, cwd: '/a', startedAt: 1, projectId: 'shop' },
      { port: 4442, pid: 2, cwd: '/a', startedAt: 2, projectId: 'shop' },
    ]);
    expect(resolveDaemonForProject('shop', dir, live)).toBe(4441);
    expect(resolveDaemonForProject('shop', dir, live, 4442)).toBe(4442);
    expect(wrongDaemonNote(4442, resolveDaemonForProject('shop', dir, live, 4442))).toBeUndefined();
  });

  /** The whole point: another project's daemon is not ours, however convenient its port. */
  it('refuses a daemon that belongs to a different project', () => {
    const dir = home([{ port: 4400, pid: 1, cwd: '/b', startedAt: 1, projectId: 'blog' }]);
    expect(resolveDaemonForProject('shop', dir, live)).toBeUndefined();
  });

  it('ignores a daemon whose process is gone', () => {
    const dir = home([{ port: 47311, pid: 1, cwd: '/a', startedAt: 1, projectId: 'shop' }]);
    expect(resolveDaemonForProject('shop', dir, dead)).toBeUndefined();
  });

  it('is deterministic when one project somehow has two daemons', () => {
    const dir = home([
      { port: 47399, pid: 1, cwd: '/a', startedAt: 1, projectId: 'shop' },
      { port: 47311, pid: 2, cwd: '/a', startedAt: 2, projectId: 'shop' },
    ]);
    expect(resolveDaemonForProject('shop', dir, live)).toBe(47311);
  });

  it('survives a corrupt entry rather than failing the whole lookup', () => {
    const dir = home([{ port: 47311, pid: 1, cwd: '/a', startedAt: 1, projectId: 'shop' }]);
    writeFileSync(join(dir, 'daemon-9999.json'), '{ not json');
    expect(resolveDaemonForProject('shop', dir, live)).toBe(47311);
  });

  it('says nothing when the project has no id to match on', () => {
    const dir = home([{ port: 4400, pid: 1, cwd: '/a', startedAt: 1, projectId: 'shop' }]);
    expect(resolveDaemonForProject(undefined, dir, live)).toBeUndefined();
  });

  it('says nothing when the registry directory does not exist', () => {
    expect(
      resolveDaemonForProject('shop', join(tmpdir(), 'reticle-nope-xyz'), live),
    ).toBeUndefined();
  });
});

/**
 * Adoption is the other half. Resolution finds OUR daemon; adoption decides whether a daemon already
 * sitting on the port we were about to use may be taken over.
 */
describe('adoptable', () => {
  /** A daemon started in a directory with no `.reticle.json` belongs to nobody, so it belongs to
   *  whoever asks. Refusing here would break every user who runs Reticle globally. */
  it('allows adopting a daemon that claims no project', () => {
    expect(adoptable(undefined, 'shop')).toBe(true);
  });

  it('allows adopting our own project’s daemon', () => {
    expect(adoptable('shop', 'shop')).toBe(true);
  });

  it('refuses another project’s daemon, which is the cross-project bleed', () => {
    expect(adoptable('blog', 'shop')).toBe(false);
  });

  /** An un-init'd caller has no identity to defend, so it keeps the old permissive behaviour. */
  it('allows a caller with no project of its own to adopt anything', () => {
    expect(adoptable('blog', undefined)).toBe(true);
  });

  /** A daemon started in a package of the caller's own workspace is the same repository. */
  it('allows a daemon that runs inside the caller project, whatever its id', () => {
    expect(adoptable('web', 'root', true)).toBe(true);
    expect(adoptable('web', 'root', false)).toBe(false);
  });
});

/**
 * Reported from the field: in a Claude Code session at a monorepo root, `init` in `apps/web` replaced
 * the daemon with one for that app. Both MCP proxies then refused every call, because the root's
 * `.reticle.json` named another project id. The daemon ran inside the agent's own repository.
 */
describe('daemonInsideProject', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      removeTempDirSync(d);
    }
  });
  function homeWith(cwd: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-inside-'));
    dirs.push(dir);
    writeFileSync(
      join(dir, 'daemon-4400.json'),
      JSON.stringify({ port: 4400, pid: 1, cwd, startedAt: 1, projectId: 'web' }),
    );
    return dir;
  }
  const repo = join(tmpdir(), 'repo');

  it('is true for a daemon in a folder below the caller project', () => {
    expect(daemonInsideProject(4400, homeWith(join(repo, 'apps', 'web')), repo)).toBe(true);
    expect(daemonInsideProject(4400, homeWith(repo), repo)).toBe(true);
  });

  it('is false for a daemon outside it, a sibling with a longer name, or no caller project', () => {
    expect(daemonInsideProject(4400, homeWith(join(tmpdir(), 'other')), repo)).toBe(false);
    expect(daemonInsideProject(4400, homeWith(`${repo}-two`), repo)).toBe(false);
    expect(daemonInsideProject(4400, homeWith(join(repo, 'apps', 'web')), undefined)).toBe(false);
    expect(daemonInsideProject(4401, homeWith(join(repo, 'apps', 'web')), repo)).toBe(false);
  });
});

/**
 * The decision an agent's MCP proxy makes on startup, which is where the machine-wide daemon came
 * from: a second project probed the default port, found a healthy daemon, and attached to it.
 */
describe('resolveMcpPort', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      removeTempDirSync(d);
    }
  });
  function home(entries: readonly Record<string, unknown>[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-mcp-'));
    dirs.push(dir);
    for (const e of entries) {
      writeFileSync(join(dir, `daemon-${String(e['port'])}.json`), JSON.stringify(e));
    }
    return dir;
  }
  const present = (): Promise<boolean> => Promise.resolve(true);
  const absent = (): Promise<boolean> => Promise.resolve(false);
  const assigned = (): Promise<number> => Promise.resolve(51234);

  it('uses our own daemon wherever it moved to, ignoring the preferred port', async () => {
    const dir = home([{ port: 47311, pid: 1, cwd: '/a', startedAt: 1, projectId: 'shop' }]);
    await expect(
      resolveMcpPort(4400, 'shop', dir, {
        alive: live,
        daemonPresent: present,
        pickPort: assigned,
      }),
    ).resolves.toBe(47311);
  });

  it('takes the preferred port when nothing is on it', async () => {
    const dir = home([]);
    await expect(
      resolveMcpPort(4400, 'shop', dir, { alive: live, daemonPresent: absent, pickPort: assigned }),
    ).resolves.toBe(4400);
  });

  it('keeps the preferred port when its daemon runs inside this project', async () => {
    const repo = join(tmpdir(), 'repo');
    const dir = home([
      { port: 4400, pid: 1, cwd: join(repo, 'apps', 'web'), startedAt: 1, projectId: 'web' },
    ]);
    const deps = { alive: live, daemonPresent: present, pickPort: assigned };
    await expect(resolveMcpPort(4400, 'root', dir, deps, undefined, repo)).resolves.toBe(4400);
    await expect(resolveMcpPort(4400, 'root', dir, deps)).resolves.toBe(51234);
  });

  /** THE defect: project B probing 4400, finding project A's daemon, and quietly joining it. */
  it('relocates rather than adopting another project’s daemon', async () => {
    const dir = home([{ port: 4400, pid: 1, cwd: '/a', startedAt: 1, projectId: 'blog' }]);
    await expect(
      resolveMcpPort(4400, 'shop', dir, {
        alive: live,
        daemonPresent: present,
        pickPort: assigned,
      }),
    ).resolves.toBe(51234);
  });

  /**
   * Moved off another project's port, the proxy chose a random one; the app kept dialling the port
   * in its own `.reticle.json`, and the agent saw no session.
   */
  it("relocates to the project's own port when it is free, not to a random one", async () => {
    const dir = home([{ port: 16022, pid: 1, cwd: '/b', startedAt: 1, projectId: 'billing' }]);
    const onlyPreferred = (p: number): Promise<boolean> => Promise.resolve(16022 === p);
    await expect(
      resolveMcpPort(
        16022,
        'auth',
        dir,
        { alive: live, daemonPresent: onlyPreferred, pickPort: assigned },
        16026,
      ),
    ).resolves.toBe(16026);
  });

  it("still picks a fresh port when the project's own one is held by another project", async () => {
    const dir = home([
      { port: 16022, pid: 1, cwd: '/b', startedAt: 1, projectId: 'billing' },
      { port: 16026, pid: 1, cwd: '/c', startedAt: 1, projectId: 'checkout' },
    ]);
    await expect(
      resolveMcpPort(
        16022,
        'auth',
        dir,
        { alive: live, daemonPresent: present, pickPort: assigned },
        16026,
      ),
    ).resolves.toBe(51234);
  });

  /** A daemon nobody claims stays shareable, or every global install breaks. */
  it('adopts an unclaimed daemon on the preferred port', async () => {
    const dir = home([{ port: 4400, pid: 1, cwd: '/a', startedAt: 1 }]);
    await expect(
      resolveMcpPort(4400, 'shop', dir, {
        alive: live,
        daemonPresent: present,
        pickPort: assigned,
      }),
    ).resolves.toBe(4400);
  });

  it('lets an un-init’d caller keep using whatever is there', async () => {
    const dir = home([{ port: 4400, pid: 1, cwd: '/a', startedAt: 1, projectId: 'blog' }]);
    await expect(
      resolveMcpPort(4400, undefined, dir, {
        alive: live,
        daemonPresent: present,
        pickPort: assigned,
      }),
    ).resolves.toBe(4400);
  });

  // #1240: an editor's user-scope MCP starts in $HOME, with no project, and dialled 4400 forever.
  it('takes the one live project daemon when a caller outside any project finds the default empty', async () => {
    const dir = home([{ port: 47311, pid: 1, cwd: '/b', startedAt: 1, projectId: 'shop' }]);
    await expect(
      resolveMcpPort(4400, undefined, dir, {
        alive: live,
        daemonPresent: absent,
        pickPort: assigned,
      }),
    ).resolves.toBe(47311);
    const two = home([
      { port: 47311, pid: 1, cwd: '/b', startedAt: 1, projectId: 'shop' },
      { port: 47312, pid: 2, cwd: '/c', startedAt: 1, projectId: 'blog' },
    ]);
    await expect(
      resolveMcpPort(4400, undefined, two, {
        alive: live,
        daemonPresent: absent,
        pickPort: assigned,
      }),
    ).resolves.toBe(4400);
    // A port somebody ASKED for is not a guess. Driven before release: `reticle mcp --port
    // 15520` in an unwired app attached to the one other project's daemon on 15500, and wiring then
    // wrote 15500 into that app's .reticle.json.
    await expect(
      resolveMcpPort(15520, undefined, dir, {
        alive: live,
        daemonPresent: absent,
        pickPort: assigned,
      }),
    ).resolves.toBe(15520);
    const note = projectlessNote(4400, projectDaemonsElsewhere(4400, two, live));
    expect(note).toContain('shop on :47311');
    expect(note).toContain('RETICLE_PORT=47311');
    expect(projectlessNote(4400, [])).toBeUndefined();
  });

  it('does not reuse a daemon of ours whose process has died', async () => {
    const dir = home([{ port: 47311, pid: 1, cwd: '/a', startedAt: 1, projectId: 'shop' }]);
    await expect(
      resolveMcpPort(4400, 'shop', dir, { alive: dead, daemonPresent: absent, pickPort: assigned }),
    ).resolves.toBe(4400);
  });
});

/**
 * The other half of the split brain: not "which daemon do I take", but "did the app take a
 * different one". `resolveMcpPort` relocating is correct and invisible; the app resolving its own
 * port independently and landing on the daemon the proxy just refused is the failure nobody reports,
 * because from either side alone everything looks healthy.
 */
describe('daemonsServingProjectElsewhere', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      removeTempDirSync(d);
    }
  });

  function home(entries: readonly Record<string, unknown>[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-split-'));
    dirs.push(dir);
    for (const e of entries) {
      writeFileSync(join(dir, `daemon-${String(e['port'])}.json`), JSON.stringify(e));
    }
    return dir;
  }

  const connectedOn =
    (...ports: number[]) =>
    (port: number): boolean =>
      ports.includes(port);

  it('names the live daemon this project’s app actually connected to', () => {
    const dir = home([
      { port: 4400, pid: 1, cwd: '/other', startedAt: 1, projectId: 'blog' },
      { port: 51234, pid: 2, cwd: '/shop', startedAt: 2, projectId: 'shop' },
    ]);
    expect(daemonsServingProjectElsewhere('shop', 51234, dir, live, connectedOn(4400))).toEqual([
      4400,
    ]);
  });

  it('says nothing when the app connected to the daemon we are asking from', () => {
    const dir = home([{ port: 4400, pid: 1, cwd: '/shop', startedAt: 1, projectId: 'shop' }]);
    expect(daemonsServingProjectElsewhere('shop', 4400, dir, live, connectedOn(4400))).toEqual([]);
  });

  it('ignores a daemon whose process is gone — history is not a split', () => {
    const dir = home([{ port: 4400, pid: 1, cwd: '/other', startedAt: 1, projectId: 'blog' }]);
    expect(daemonsServingProjectElsewhere('shop', 51234, dir, dead, connectedOn(4400))).toEqual([]);
  });

  it('ignores a live daemon this project never connected to', () => {
    const dir = home([{ port: 4400, pid: 1, cwd: '/other', startedAt: 1, projectId: 'blog' }]);
    expect(daemonsServingProjectElsewhere('shop', 51234, dir, live, connectedOn())).toEqual([]);
  });

  /**
   * #2341: `.reticle.json` moved this project from :4441 to :4442. The daemon on the prior port is
   * still alive and remembers a session, but the page dials the configured port (core's
   * `pickDaemonPort`, rule 1), so a lease on the current URL connects here. The record is history.
   */
  it('ignores a prior port when the page dials this daemon on the configured port', () => {
    const dir = home([
      { port: 4441, pid: 1, cwd: '/shop', startedAt: 1, projectId: 'shop' },
      { port: 4442, pid: 2, cwd: '/shop', startedAt: 2, projectId: 'shop' },
    ]);
    expect(
      daemonsServingProjectElsewhere('shop', 4442, dir, live, connectedOn(4441, 4442), 4442),
    ).toEqual([]);
  });

  it('still names the other daemon when the configured port is not this one', () => {
    const dir = home([
      { port: 4441, pid: 1, cwd: '/shop', startedAt: 1, projectId: 'shop' },
      { port: 4442, pid: 2, cwd: '/shop', startedAt: 2, projectId: 'shop' },
    ]);
    expect(
      daemonsServingProjectElsewhere('shop', 4442, dir, live, connectedOn(4441), 4441),
    ).toEqual([4441]);
  });

  /** The page skips a configured port that another project's daemon holds (`pickDaemonPort`). */
  it('still names the other daemon when another project holds the configured port', () => {
    const dir = home([
      { port: 4441, pid: 1, cwd: '/shop', startedAt: 1, projectId: 'shop' },
      { port: 4442, pid: 2, cwd: '/blog', startedAt: 2, projectId: 'blog' },
    ]);
    expect(
      daemonsServingProjectElsewhere('shop', 4442, dir, live, connectedOn(4441), 4442),
    ).toEqual([4441]);
  });

  /** No identity, no claim: a caller with no projectId cannot tell its own sessions from anyone's. */
  it('says nothing for a caller with no project', () => {
    const dir = home([{ port: 4400, pid: 1, cwd: '/other', startedAt: 1, projectId: 'blog' }]);
    expect(daemonsServingProjectElsewhere(undefined, 51234, dir, live, connectedOn(4400))).toEqual(
      [],
    );
  });
});

describe('splitBrainNote', () => {
  it('is silent when there is no split', () => {
    expect(splitBrainNote(4400, [])).toBeUndefined();
  });

  it('names both ports, says the attached one is the empty half, and gives a command', () => {
    const note = splitBrainNote(51234, [4400]);
    expect(note).toContain(':4400');
    expect(note).toContain(':51234');
    expect(note).toContain('RETICLE_PORT=4400');
  });

  /**
   * The daemon the app is on is a working session the agent did not start (#1546). The advice moves
   * the agent first and leaves that daemon alone; stopping it comes last, with what it costs.
   */
  it('leads with moving the agent, and puts stopping the app daemon last with its cost', () => {
    const note = splitBrainNote(51234, [4400]) ?? '';
    const attach = note.indexOf('RETICLE_PORT=4400');
    const stop = note.indexOf('reticle stop --port 4400');
    expect(attach).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(attach);
    expect(note).toContain('restart the agent session');
    expect(note).toContain('Leave :4400 running');
    expect(note.slice(stop)).toContain('disconnects every tab and agent');
  });

  /** The advice that would be wrong: this is not an install problem and must not read as one. */
  it('does not send the reader back to init', () => {
    expect(splitBrainNote(51234, [4400])).not.toContain('init');
  });

  it('keeps the RETICLE_PORT advice when the daemon the app is on is this project’s or nobody’s', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-split-'));
    try {
      writeFileSync(
        join(dir, 'daemon-4400.json'),
        JSON.stringify({ port: 4400, pid: 1, cwd: '/b', startedAt: 1, projectId: 'shop' }),
      );
      expect(splitBrainNote(51234, [4400], { projectId: 'shop', home: dir })).toContain(
        'RETICLE_PORT=4400',
      );
      expect(splitBrainNote(51234, [4401], { projectId: 'shop', home: dir })).toContain(
        'RETICLE_PORT=4401',
      );
    } finally {
      removeTempDirSync(dir);
    }
  });

  /**
   * #1652: two projects on one default port. Project B's app connected to project A's daemon on
   * :4400. Following "set RETICLE_PORT=4400" cannot work, because `resolveMcpPort` never adopts
   * another project's daemon and relocates again. The advice and the resolver must agree.
   */
  it('does not offer RETICLE_PORT for a daemon registered to another project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-split-'));
    try {
      writeFileSync(
        join(dir, 'daemon-4400.json'),
        JSON.stringify({ port: 4400, pid: 1, cwd: '/a', startedAt: 1, projectId: 'blog' }),
      );
      // What the agent would get after following RETICLE_PORT=4400: relocated off :4400 again.
      await expect(
        resolveMcpPort(4400, 'shop', dir, {
          alive: live,
          daemonPresent: () => Promise.resolve(true),
          pickPort: () => Promise.resolve(51234),
        }),
      ).resolves.toBe(51234);

      const note = splitBrainNote(51234, [4400], { projectId: 'shop', home: dir }, {}) ?? '';
      expect(note).toContain(':4400');
      expect(note).toContain(':51234');
      expect(note).toContain('"blog"');
      expect(note).not.toContain('RETICLE_PORT');
      expect(note).toContain('.reticle.json');
      expect(note).toContain('restart the dev server');
      expect(note).not.toContain('init');
    } finally {
      removeTempDirSync(dir);
    }
  });

  /** RETICLE_PORT outranks `.reticle.json`, so the old advice left in the MCP env makes `port` inert. */
  it('tells the reader to remove RETICLE_PORT first when it is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-split-'));
    try {
      writeFileSync(
        join(dir, 'daemon-4400.json'),
        JSON.stringify({ port: 4400, pid: 1, cwd: '/a', startedAt: 1, projectId: 'blog' }),
      );
      const owner = { projectId: 'shop', home: dir };
      const note = splitBrainNote(51234, [4400], owner, { RETICLE_PORT: '4400' }) ?? '';
      expect(note).toContain("remove RETICLE_PORT from the agent's MCP config");
      expect(note).toContain('takes precedence over `.reticle.json`');
      expect(note.indexOf('remove RETICLE_PORT')).toBeLessThan(note.indexOf('`port`'));
      // An unusable value does not outrank anything, so it gets the plain advice.
      expect(splitBrainNote(51234, [4400], owner, { RETICLE_PORT: 'abc' })).not.toContain(
        'RETICLE_PORT',
      );
    } finally {
      removeTempDirSync(dir);
    }
  });

  /** An unknown caller id is adoptable by any daemon, so the old advice stays: no project to give a port to. */
  it('keeps the RETICLE_PORT advice when the caller has no projectId', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-split-'));
    try {
      writeFileSync(
        join(dir, 'daemon-4400.json'),
        JSON.stringify({ port: 4400, pid: 1, cwd: '/a', startedAt: 1, projectId: 'blog' }),
      );
      const note = splitBrainNote(51234, [4400], { projectId: undefined, home: dir }, {}) ?? '';
      expect(note).toContain('RETICLE_PORT=4400');
      expect(note).not.toContain('.reticle.json');
    } finally {
      removeTempDirSync(dir);
    }
  });
});

/*
 * Re-drive (persona 02): a proxy given RETICLE_PORT=17505 attached to this project's own daemon on
 * :4400 (started by `connect`) and logged "the requested port serves a different project" — both
 * served the same project. The reason says what happened, and how to change it.
 */
describe('relocationReason', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      removeTempDirSync(d);
    }
  });
  function home(entries: readonly Record<string, unknown>[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-reloc-'));
    dirs.push(dir);
    for (const e of entries) {
      writeFileSync(join(dir, `daemon-${String(e['port'])}.json`), JSON.stringify(e));
    }
    return dir;
  }

  it("says this project's own daemon is elsewhere, and how to use the requested port", () => {
    const dir = home([{ port: 4400, pid: 1, cwd: '/a', startedAt: 1, projectId: 'nina-app' }]);
    const reason = relocationReason(17505, 4400, 'nina-app', dir, live);
    expect(reason).toContain("this project's daemon is already running on :4400");
    expect(reason).toContain('reticle stop --port 4400');
    expect(reason).not.toContain('different project');
  });

  it('names the other project holding the requested port', () => {
    const dir = home([{ port: 4400, pid: 1, cwd: '/a', startedAt: 1, projectId: 'blog' }]);
    const reason = relocationReason(4400, 51234, 'shop', dir, live);
    expect(reason).toContain('project "blog"');
    expect(reason).toContain(':51234');
  });
});
