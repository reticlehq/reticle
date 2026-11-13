/**
 * Say on a console line that the page raised it before the SDK attached (#1540).
 *
 * The build plugin's inline buffer holds what an app raised while nothing listened: an entry module
 * that 404'd or threw, a rejection, a `console.error` during start-up. The SDK reports it when it
 * attaches, marked `preAttach`. Without the mark on the line the agent reads, a reported error looks
 * like one the last action caused, and the reason a page is blank is not read as a load failure.
 *
 * Here and not in the engine's `projectConsoleLog`: the engine does not take new names from core.
 */
import { CONSOLE_EVENT, asNumber, type ReticleEvent } from '@reticlehq/core';

export interface PreAttachMark {
  /** The page raised it before the SDK attached. */
  preAttach?: true;
  /** How many more pre-attach errors the full buffer did not keep — loss, declared. */
  droppedPreAttach?: number;
}

/** The console line, with the pre-attach mark and the declared loss when the event carries them. */
export function withPreAttach<T extends object>(view: T, e: ReticleEvent): T & PreAttachMark {
  const mark: PreAttachMark = {};
  if (true === e.data[CONSOLE_EVENT.PRE_ATTACH]) {
    mark.preAttach = true;
  }
  const dropped = asNumber(e.data[CONSOLE_EVENT.DROPPED_PRE_ATTACH]);
  if (dropped !== undefined && dropped > 0) {
    mark.droppedPreAttach = dropped;
  }
  return { ...view, ...mark };
}
