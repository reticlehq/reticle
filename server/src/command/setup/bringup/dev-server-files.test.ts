import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  devServerLogName,
  handedOverUrl,
  recordHandOver,
  stopHandedOver,
  sweepDeadDevServers,
} from './dev-server-files.js';

const APP = '/work/next-app';
const URL = 'http://localhost:3000';
const temp = (): string => mkdtempSync(join(tmpdir(), 'dev-server-files-'));

/**
 * Re-running init while the Next or Angular server it had started was still up exited 1: "port 3000
 * is already in use — something else is serving there". Only Vite announces itself, so init never
 * knew the server on 3000 was its own. The handover now leaves a record the next run attaches by.
 */
describe('finding the server init handed over', () => {
  it('attaches when that process is alive and its url still answers', async () => {
    const dir = temp();
    recordHandOver(dir, { pid: 4242, url: URL, appDir: APP });
    const found = await handedOverUrl(dir, APP, {
      alive: (pid) => 4242 === pid,
      answers: (url) => Promise.resolve(URL === url),
    });
    expect(found).toBe(URL);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not, when the process is gone or the url answers nothing', async () => {
    const dir = temp();
    recordHandOver(dir, { pid: 4242, url: URL, appDir: APP });
    const dead = { alive: () => false, answers: () => Promise.resolve(true) };
    const silent = { alive: () => true, answers: () => Promise.resolve(false) };
    expect(await handedOverUrl(dir, APP, dead)).toBeUndefined();
    expect(await handedOverUrl(dir, APP, silent)).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('never hands one project another project’s server', async () => {
    const dir = temp();
    recordHandOver(dir, { pid: 4242, url: URL, appDir: APP });
    const live = { alive: () => true, answers: () => Promise.resolve(true) };
    expect(await handedOverUrl(dir, '/work/other-app', live)).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

/** Nothing ever deleted a dev-server log, so the state home kept one per app init ever started. */
describe('restarting the server init handed over, when the port moved under it', () => {
  it("stops this app's live server and forgets it", () => {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-devfiles-'));
    recordHandOver(dir, { pid: 4242, url: URL, appDir: APP });
    const killed: number[] = [];
    const stopped = stopHandedOver(dir, APP, {
      alive: () => true,
      kill: (pid) => killed.push(pid),
    });
    expect(stopped).toBe(true);
    expect(killed).toEqual([4242]);
    expect(stopHandedOver(dir, APP, { alive: () => true, kill: () => undefined })).toBe(false);
  });

  it('never touches a process it did not record for this app', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-devfiles-'));
    recordHandOver(dir, { pid: 4242, url: URL, appDir: '/work/other' });
    const killed: number[] = [];
    expect(stopHandedOver(dir, APP, { alive: () => true, kill: (pid) => killed.push(pid) })).toBe(
      false,
    );
    recordHandOver(dir, { pid: 4343, url: URL, appDir: APP });
    expect(stopHandedOver(dir, APP, { alive: () => false, kill: (pid) => killed.push(pid) })).toBe(
      false,
    );
    expect(killed).toEqual([]);
  });
});

describe('sweeping what dead servers left', () => {
  it('removes the log, rotated log and record of a server that is gone, and keeps a live one', () => {
    const dir = temp();
    const gone = devServerLogName('/work/gone');
    const live = devServerLogName('/work/live');
    for (const f of [gone, `${gone}.1`, live]) writeFileSync(join(dir, f), 'x');
    recordHandOver(dir, { pid: 1, url: URL, appDir: '/work/gone' });
    recordHandOver(dir, { pid: 2, url: URL, appDir: '/work/live' });
    writeFileSync(join(dir, 'devserver-5173.json'), '{}'); // the Vite registry: not ours
    sweepDeadDevServers(dir, { alive: (pid) => 2 === pid, now: Date.now() });
    const left = readdirSync(dir);
    expect(left.some((f) => f.startsWith(gone.replace('.log', '')))).toBe(false);
    expect(left).toContain(live);
    expect(left).toContain('devserver-5173.json');
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes an unrecorded log only once it is old', () => {
    const dir = temp();
    const old = join(dir, devServerLogName('/work/old'));
    const recent = join(dir, devServerLogName('/work/recent'));
    writeFileSync(old, 'x');
    writeFileSync(recent, 'x');
    const now = Date.now();
    const twoDaysAgo = (now - 2 * 24 * 60 * 60_000) / 1000;
    utimesSync(old, twoDaysAgo, twoDaysAgo);
    sweepDeadDevServers(dir, { alive: () => false, now });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
