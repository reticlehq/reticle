import { IrisTool, type ToolInvoker } from '@iris/server';
import { ActionType, InputMode } from '@iris/protocol';
import { resolveTestid } from './resolve.js';
import { IrisSkip } from './skip.js';
import { PROBE_TESTID, SKIP_REASON_REAL_INPUT } from './constants.js';

/** The act envelope's inputMode field, narrowed from the raw tool result. */
export function readInputMode(actResult: unknown): InputMode | undefined {
  if (typeof actResult !== 'object' || actResult === null) return undefined;
  const mode = (actResult as Record<string, unknown>)['inputMode'];
  if (mode === InputMode.REAL || mode === InputMode.SYNTHETIC) return mode;
  return undefined;
}

/**
 * Tracks the most recent act's inputMode across a spec so `expectInputModeReal()` can read it
 * without re-touching the page. The context records every act through `record`.
 */
export class InputModeTracker {
  private last: InputMode | undefined;

  record(actResult: unknown): void {
    const mode = readInputMode(actResult);
    if (mode !== undefined) this.last = mode;
  }

  get(): InputMode | undefined {
    return this.last;
  }
}

/**
 * Assert real native input is active. Prefers the last act's reported mode (zero extra page
 * mutation); if no act has run, issues a non-mutating SCROLL_INTO_VIEW probe and reads its mode.
 * On 'synthetic' throws IrisSkip(SKIP_REASON_REAL_INPUT) — the runner turns this into status:'skip'.
 * It NEVER silently passes on synthetic.
 */
export async function expectInputModeReal(
  invoke: ToolInvoker,
  tracker: InputModeTracker,
  sessionId?: string,
): Promise<void> {
  let mode = tracker.get();
  if (mode === undefined) {
    mode = await probeInputMode(invoke, sessionId);
  }
  if (mode !== InputMode.REAL) {
    throw new IrisSkip(SKIP_REASON_REAL_INPUT);
  }
}

/** Run a non-mutating pointer-free act to read inputMode without changing spec state. */
async function probeInputMode(invoke: ToolInvoker, sessionId?: string): Promise<InputMode> {
  const ref = await resolveTestid(invoke, PROBE_TESTID, sessionId);
  const args: Record<string, unknown> = {
    ref,
    action: ActionType.SCROLL_INTO_VIEW,
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
  const result = await invoke(IrisTool.ACT, args);
  return readInputMode(result) ?? InputMode.SYNTHETIC;
}
