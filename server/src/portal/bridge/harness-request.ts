/**
 * What the panel's Harness controls asked for, narrowed at the boundary: the autonomous switch,
 * Run Harness (with an optional persona), or Stop. Keyed by the control's own wire kind.
 *
 * The switch carries `on`/`off` rather than meaning "toggle": a double-click on a flaky connection
 * sends two, and two toggles land back where they started while two `on`s are the same as one.
 */
import { EventType, HumanControlKind } from '@reticlehq/core';

export type HarnessRequest =
  | { kind: typeof HumanControlKind.HARNESS; enabled: boolean }
  | { kind: typeof HumanControlKind.HARNESS_RUN; persona?: string }
  | { kind: typeof HumanControlKind.HARNESS_STOP };

export function harnessRequest(event: {
  type: string;
  data: Record<string, unknown>;
}): HarnessRequest | undefined {
  if (event.type !== EventType.HUMAN_CONTROL) return undefined;
  const kind = event.data['kind'];
  const text = event.data['text'];
  if (HumanControlKind.HARNESS_STOP === kind) return { kind };
  if (HumanControlKind.HARNESS_RUN === kind) {
    const persona = 'string' === typeof text ? text.trim() : '';
    return 0 < persona.length ? { kind, persona } : { kind };
  }
  if (HumanControlKind.HARNESS !== kind) return undefined;
  if ('on' === text) return { kind, enabled: true };
  if ('off' === text) return { kind, enabled: false };
  return undefined;
}
