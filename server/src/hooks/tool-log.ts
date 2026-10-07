import { appendFileSync } from 'node:fs';
import { currentDrivenBy } from '@/hooks/driven-by.js';

/**
 * Every tool call, its arguments and what it answered, appended to a file a person names.
 *
 * Off unless `RETICLE_TOOL_LOG` is set. It exists to put two drives side by side (an agent's and
 * the Harness's) and read what each one asked and was told; `drivenBy` says which was which. Local
 * only: nothing here leaves the machine.
 */
const TOOL_LOG_ENV = 'RETICLE_TOOL_LOG';
/** A page snapshot can be large; past this a record keeps its head and says it was cut. */
const MAX_RESULT_CHARS = 200_000;

export function toolLogPath(): string | undefined {
  const path = process.env[TOOL_LOG_ENV];
  return path === undefined || 0 === path.trim().length ? undefined : path;
}

export function logToolCall(
  path: string,
  entry: { tool: string; args: unknown; at: number; ms: number; result?: unknown; error?: string },
): void {
  try {
    const text = JSON.stringify(entry.result ?? null);
    const result =
      text.length > MAX_RESULT_CHARS
        ? { truncated: text.slice(0, MAX_RESULT_CHARS) }
        : entry.result;
    const drivenBy = currentDrivenBy();
    appendFileSync(
      path,
      `${JSON.stringify({ ...entry, result, ...(drivenBy === undefined ? {} : { drivenBy }) })}\n`,
    );
  } catch {
    /* a log that cannot be written never fails the call it describes */
  }
}
