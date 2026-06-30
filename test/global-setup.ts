import { execSync } from 'node:child_process';

/**
 * Free the fixed ports the integration suite binds — BEFORE the run (clears a dev server / Reticle bridge
 * left squatting by a previous run that was hard-killed mid-suite, since a worker's `afterEach` does not
 * fire on interruption — exactly the bridge-on-:4400 contamination we hit) AND AFTER the run via the
 * returned teardown (clears a grandchild dev server that escaped its process group during this run —
 * astro/remix do this). Both run in the MAIN vitest process, where spawning `lsof`/`kill` is safe;
 * doing the same from a worker intermittently closes the worker's IPC channel. Best-effort, unix-only.
 */
const PORTS = [
  4400, // the frameworks test's Reticle bridge
  5301,
  5302,
  5303,
  5304, // the example-app dev servers (react / next / remix / astro)
];

function freePorts(): void {
  for (const port of PORTS) {
    try {
      execSync(`lsof -ti tcp:${String(port)} 2>/dev/null | xargs -I{} kill -9 {} 2>/dev/null`, {
        stdio: 'ignore',
      });
    } catch {
      /* nothing on the port, or not a unix host — fine */
    }
  }
}

export default function setup(): () => void {
  freePorts(); // before the run: evict leftovers from a previously-interrupted run
  return freePorts; // after the run: evict any grandchild dev server that escaped its process group
}
