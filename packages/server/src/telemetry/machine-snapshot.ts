/**
 * What the machine looked like at a moment worth remembering.
 *
 * "Out of memory" and "our bug" produce identical-looking stack traces and are completely different
 * problems — one is a docs/limits issue on the user's side, the other is ours to fix. Without this,
 * every crash report arrived with that ambiguity baked in and no way to resolve it after the fact.
 *
 * Sampled at MOMENTS — a crash, the end of a session — never per tool call. `os.loadavg()` and
 * `process.memoryUsage()` are cheap but not free, and taking them two hundred times a session to
 * answer a question only ever asked about the bad moments would be a continuous cost for an
 * occasional need.
 *
 * Nothing here describes the person: it is our own process's footprint plus coarse machine capacity.
 * No hostname, no username, no disk paths, no process list.
 */
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import type { MachineSnapshot } from '@reticlehq/core/telemetry';

const MB = 1024 * 1024;

/**
 * Sample the machine. Never throws — this is called from a crash handler, where the one unacceptable
 * outcome is making the crash worse.
 */
export function machineSnapshot(): MachineSnapshot | undefined {
  try {
    const memory = process.memoryUsage();
    return {
      rssMb: Math.round(memory.rss / MB),
      heapUsedMb: Math.round(memory.heapUsed / MB),
      freeMemMb: Math.round(freemem() / MB),
      totalMemMb: Math.round(totalmem() / MB),
      // ×100 so it stays an integer property rather than a float. Windows always reports 0 here,
      // which is a platform fact rather than an idle machine — read it alongside `os`.
      load1x100: Math.max(0, Math.round((loadavg()[0] ?? 0) * 100)),
      cpuCount: cpus().length,
    };
  } catch {
    return undefined;
  }
}
