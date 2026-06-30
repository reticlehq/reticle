import { ReticleTool, type ToolInvoker } from '@reticlehq/server';
import { InputMode } from '@reticlehq/protocol';
import { ReticleSkip } from './skip.js';
import { SKIP_REASON_REAL_INPUT } from './constants.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

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
 * On 'synthetic' throws ReticleSkip(SKIP_REASON_REAL_INPUT) — the runner turns this into status:'skip'.
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
    throw new ReticleSkip(SKIP_REASON_REAL_INPUT);
  }
}

/**
 * Read whether native real input is active for the session WITHOUT touching the page: reticle_sessions
 * reports `realInputAvailable` per session (true when a CDP/launched provider matches the tab url).
 * App-agnostic — no assumed testid.
 */
async function probeInputMode(invoke: ToolInvoker, sessionId?: string): Promise<InputMode> {
  const result = await invoke(ReticleTool.SESSIONS, {});
  const sessions = isRecord(result) && Array.isArray(result['sessions']) ? result['sessions'] : [];
  for (const session of sessions) {
    if (!isRecord(session)) continue;
    if (sessionId === undefined || session['sessionId'] === sessionId) {
      return session['realInputAvailable'] === true ? InputMode.REAL : InputMode.SYNTHETIC;
    }
  }
  return InputMode.SYNTHETIC;
}
