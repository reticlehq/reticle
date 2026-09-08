/**
 * The machine-wide scope has MANY writers, and used to be written as if it had one.
 *
 * Reported from the HUD: switching the report from "this project" to "everything on this machine"
 * showed a SHORTER streak. That is not a rendering quirk, it is arithmetic that cannot happen — more
 * activity cannot mean fewer consecutive days — so it is proof the machine-wide file is losing
 * writes.
 *
 * The mechanism: `ImpactStore` read the global scope once in its constructor, folded deltas into
 * that in-memory copy, and wrote the whole copy back on flush. `writeScope` is atomic against a TORN
 * write (tmp + rename, and its comment says so) and nothing made it atomic against a LOST one. The
 * project scope survives that because it has a single writer; `~/.reticle/impact.json` is shared by
 * every daemon on the machine, so the second flush of the day erases the first one's day from
 * `days[]`, `previousDay` stops chaining, and `streakDays` resets to 1.
 *
 * The original comment shows the shape was half-seen: it reasons about two daemons in the SAME repo,
 * which the project scope tolerates, and never carries the reasoning across to the one file that
 * genuinely has many writers.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImpactStore, readScope } from './impact-store.js';

const roots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'reticle-impact-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;
/** 2026-01-01T12:00:00Z — midday so a day boundary is never an hour away. */
const DAY_ONE = Date.UTC(2026, 0, 1, 12);

/** A store for one project, sharing an explicit machine-wide scope with its siblings. */
function storeFor(globalRoot: string, at: () => number): ImpactStore {
  return new ImpactStore({ reticleRoot: tempRoot(), globalRoot, now: at });
}

describe('the machine-wide scope survives more than one project', () => {
  it('does not lose a day when a second project flushes after the first', () => {
    const globalRoot = tempRoot();
    let now = DAY_ONE;
    const at = (): number => now;

    // Day one: project A verifies. Day two: project B does. A machine-wide streak of 2.
    const a = storeFor(globalRoot, at);
    a.record({ verdicts: 1 });
    a.flush();

    now = DAY_ONE + DAY;
    const b = storeFor(globalRoot, at);
    b.record({ verdicts: 1 });
    b.flush();

    const machine = readScope(join(globalRoot, '.reticle', 'impact.json'), now);
    expect(machine.records.streakDays, 'two consecutive days on one machine is a streak of 2').toBe(
      2,
    );
    expect(machine.counts.verdicts, 'both projects’ verdicts are the machine’s verdicts').toBe(2);
  });

  it('never reports a machine streak shorter than a single project’s', () => {
    // The reported symptom, stated as the invariant it violates: more activity cannot mean fewer
    // consecutive days.
    const globalRoot = tempRoot();
    let now = DAY_ONE;
    const at = (): number => now;

    // B opens on day one and sits idle — the long-lived daemon whose in-memory copy goes stale.
    const b = storeFor(globalRoot, at);

    const a = storeFor(globalRoot, at);
    for (const day of [0, 1, 2]) {
      now = DAY_ONE + day * DAY;
      a.record({ verdicts: 1 });
      a.flush();
    }
    const projectStreak = a.snapshot().project.records.streakDays;
    expect(projectStreak, 'three consecutive days in one project').toBe(3);

    // B finally writes, on the LATEST day, holding a copy from before any of A's work. Writing that
    // copy wholesale is what erased A's days and reset the machine streak to 1.
    b.record({ verdicts: 1 });
    b.flush();

    const machine = readScope(join(globalRoot, '.reticle', 'impact.json'), now);
    expect(machine.records.streakDays).toBeGreaterThanOrEqual(projectStreak);
  });

  it('keeps a sibling’s totals that landed after this store was constructed', () => {
    // The lost-update in its simplest form: B is already open when A writes, so B's in-memory copy
    // predates A's day. B must not publish that stale copy as the machine's truth.
    const globalRoot = tempRoot();
    const now = DAY_ONE;
    const at = (): number => now;

    const b = storeFor(globalRoot, at); // constructed FIRST, flushes LAST
    const a = storeFor(globalRoot, at);
    a.record({ verdicts: 3 });
    a.flush();

    b.record({ verdicts: 1 });
    b.flush();

    const machine = readScope(join(globalRoot, '.reticle', 'impact.json'), now);
    expect(machine.counts.verdicts, 'A’s three must survive B’s flush').toBe(4);
  });

  it('leaves the project scope alone — it has one writer and needs no merge', () => {
    const globalRoot = tempRoot();
    const now = DAY_ONE;
    const projectRoot = tempRoot();
    const store = new ImpactStore({ reticleRoot: projectRoot, globalRoot, now: () => now });
    store.record({ verdicts: 2 });
    store.flush();
    expect(readScope(join(projectRoot, 'impact.json'), now).counts.verdicts).toBe(2);
    expect(existsSync(join(globalRoot, '.reticle', 'impact.json'))).toBe(true);
  });
});
