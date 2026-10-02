/**
 * The config surface: `.reticle/hooks.json` says what to run, this runs it.
 *
 * A subscriber on the bus like any other, which is the point — it has no privileges the in-process
 * API does not have, and if this file were deleted the bus would carry on. That is what keeps the
 * two surfaces honest about being adapters rather than two half-implementations of one idea.
 *
 * ── TRUST ───────────────────────────────────────────────────────────────────────────────────────
 * The command is read from a file inside the user's own repository and run with a shell, which is
 * exactly the trust level `package.json` scripts and git hooks already have there: cloning a repo
 * runs nothing, and a command runs only when the event it is attached to actually happens.
 *
 * The payload NEVER touches the command line. It is written to the child's stdin as JSON, so a
 * defect's own text — a page title, an assertion message, anything the app under test produced —
 * cannot become part of a command. That is the one place a plausible injection could enter, and it
 * is closed by construction rather than by escaping, because escaping is a thing you get wrong once.
 *
 * ── NEVER IN THE WAY ────────────────────────────────────────────────────────────────────────────
 * Detached from the caller entirely: nothing awaits the child, a non-zero exit is reported and not
 * raised, and a child that hangs is killed on a timeout rather than held. A user whose script is
 * broken gets a log line; their verdicts keep working.
 */

import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HOOK_EVENT_NAMES, HookConfigSchema, type HookPayload } from '@reticlehq/core/hooks';
import { ReticleDir } from '@reticlehq/core';
import { log } from '@/log.js';
import { onHook } from './hook-bus.js';
import { setHookProjectId } from './hook-emit.js';

/**
 * How long a hook command may run before it is killed.
 *
 * Generous, because a hook that posts to an API over a slow connection is a legitimate use and the
 * cost of killing it early is a silently missing notification. Bounded, because a child that never
 * exits would otherwise accumulate one process per verdict for the life of the daemon.
 */
const HOOK_TIMEOUT_MS = 30_000;

/**
 * How many hook processes may be in flight at once.
 *
 * A drive can produce verdicts faster than a script can finish, and without a cap a slow hook turns
 * a busy session into hundreds of processes — which is not a hook misbehaving, it is us handing a
 * user a foot-gun and calling it configuration. Over the cap, the event is DROPPED and said so:
 * queueing would mean delivering a notification about a bug long after the session that found it,
 * and a late notification reads as a current one.
 */
const MAX_IN_FLIGHT = 8;

let inFlight = 0;
const reported = new Set<string>();

function reportOnce(key: string, message: string): void {
  if (reported.has(key)) return;
  reported.add(key);
  log(`hook: ${message}`);
}

/** Cached config plus the mtime it was read at, so an edit takes effect without a daemon restart. */
let cached: { at: number; config: Record<string, string> } | undefined;

/**
 * Read `.reticle/hooks.json`, or nothing.
 *
 * Re-read when the file's mtime moves. A `stat` per event is nothing next to spawning a process,
 * and the alternative — read once at startup — means a user editing their hooks has to know to
 * restart a daemon they never started by hand.
 */
export function readHookConfig(reticleRoot: string): Record<string, string> {
  const path = join(reticleRoot, ReticleDir.HOOKS_FILE);
  let mtime: number;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    cached = undefined;
    return {};
  }
  if (cached !== undefined && cached.at === mtime) return cached.config;
  try {
    const parsed = HookConfigSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success) {
      reportOnce(
        `config:${String(mtime)}`,
        `${ReticleDir.HOOKS_FILE} is not a map of event→command`,
      );
      cached = { at: mtime, config: {} };
      return {};
    }
    // An unknown event name is the likeliest mistake in this file and the one that is otherwise
    // invisible — the hook simply never runs, which looks identical to Reticle not finding bugs.
    const known: Record<string, string> = {};
    for (const [event, command] of Object.entries(parsed.data)) {
      if ((HOOK_EVENT_NAMES as readonly string[]).includes(event)) {
        known[event] = command;
        continue;
      }
      reportOnce(
        `unknown:${event}`,
        `${ReticleDir.HOOKS_FILE} names "${event}", which is not a Reticle event. Known events: ${HOOK_EVENT_NAMES.join(', ')}`,
      );
    }
    cached = { at: mtime, config: known };
    return known;
  } catch (error) {
    reportOnce(
      `parse:${String(mtime)}`,
      `${ReticleDir.HOOKS_FILE} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
    cached = { at: mtime, config: {} };
    return {};
  }
}

/** Run one command with the payload on stdin. Returns immediately; nothing here is awaited. */
export function runHookCommand(command: string, payload: HookPayload, cwd: string): void {
  if (inFlight >= MAX_IN_FLIGHT) {
    reportOnce(
      `saturated:${command}`,
      `dropping ${payload.event}: ${String(MAX_IN_FLIGHT)} hook commands already running. A hook that cannot keep up with a drive should hand off to something that queues.`,
    );
    return;
  }
  inFlight += 1;
  let child;
  try {
    child = spawn(command, {
      cwd,
      shell: true,
      // The payload goes in on stdin; the child's own output is inherited so a user's `echo` lands
      // where they expect rather than vanishing into a daemon nobody is watching.
      stdio: ['pipe', 'inherit', 'inherit'],
      timeout: HOOK_TIMEOUT_MS,
    });
  } catch (error) {
    inFlight -= 1;
    reportOnce(`spawn:${command}`, `could not start "${command}": ${String(error)}`);
    return;
  }
  const done = (): void => {
    inFlight = Math.max(0, inFlight - 1);
  };
  child.on('error', (error: Error) => {
    done();
    reportOnce(`run:${command}`, `"${command}" failed to run: ${error.message}`);
  });
  child.on('close', (code: number | null) => {
    done();
    if (null !== code && 0 !== code) {
      reportOnce(`exit:${command}:${String(code)}`, `"${command}" exited ${String(code)}`);
    }
  });
  // A child that closed stdin early (or never read it) must not take the daemon down with EPIPE.
  child.stdin?.on('error', () => undefined);
  try {
    child.stdin?.end(`${JSON.stringify(payload)}\n`);
  } catch {
    /* the child is already gone; its exit is reported above */
  }
}

/**
 * Attach the config surface to the bus.
 *
 * Subscribes once, for every event, and decides per payload — rather than reading the config now
 * and subscribing to the events it names. Those differ the moment somebody edits the file: the
 * eager version would keep running yesterday's hooks and ignore today's.
 */
export function installCommandHooks(reticleRoot: string): () => void {
  return onHook(undefined, (payload: HookPayload) => {
    const command = readHookConfig(reticleRoot)[payload.event];
    if (command === undefined || 0 === command.trim().length) return;
    runHookCommand(command, payload, reticleRoot);
  });
}

/**
 * Wire BOTH halves of hooks for one entry point: the config surface, and the project id payloads
 * carry.
 *
 * Exists because `start()` and `startDaemon()` each wire their own world, and a line added to one
 * of them is not added to the other. `installCommandHooks` was in `startDaemon` alone, so
 * `.reticle/hooks.json` did nothing under `reticle drive`, `reticle verify` and `reticle demo` —
 * three commands that run a whole verification and emit every event a hook subscribes to. The
 * in-process surface (`onHook`) worked on both, so the feature looked wired; only the
 * file-configured half was dead, and it is the half a user who has not written code can reach.
 *
 * `initImpact` had already been fixed for exactly this, one line at a time, and the comment left
 * beside it in `startDaemon` says so. One function is what stops the next one.
 *
 * Costs nothing when unused: with no `.reticle/hooks.json` the listener reads an absent file, gets
 * an empty map and returns.
 */
export function wireHooks(reticleRoot: string, projectId: string | undefined): () => void {
  setHookProjectId(projectId);
  return installCommandHooks(reticleRoot);
}
