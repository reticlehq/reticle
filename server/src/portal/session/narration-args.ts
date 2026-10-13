/**
 * A narration line for the HUD, and who it is from.
 *
 * A Harness line names the Harness, so the HUD files it in the Harness log rather than the Agent
 * Log: two drivers in one log read as one muddle and credited the agent with the Harness's steps. A
 * `summary` line (a run starting or ending) is shown in the Agent Log too, because the agent that
 * asked for the run reports its result.
 */
import { CommandActor } from '@reticlehq/core';

export interface NarrationBy {
  harness: true;
  summary?: boolean;
}

export function narrationArgs(text: string, by?: NarrationBy): Record<string, unknown> {
  return {
    text,
    level: 'info',
    ...(by === undefined ? {} : { actor: CommandActor.HARNESS }),
    ...(true === by?.summary ? { summary: true } : {}),
  };
}
