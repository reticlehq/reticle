import { CommandActor, MessageKind } from '@reticlehq/core';
import { currentDrivenBy } from '@/hooks/driven-by.js';

/**
 * The command a session sends its page, as wire JSON.
 *
 * Marked `by: harness` when the Harness is the one calling, so the HUD can show the person watching
 * which of the two is driving their app. Absent means the connected agent, which is also what an
 * older page that does not know the field assumes.
 */
export function commandPayload(
  id: string,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
): string {
  return JSON.stringify({
    kind: MessageKind.COMMAND,
    id,
    sessionId,
    name,
    args,
    ...(currentDrivenBy() === undefined ? {} : { by: CommandActor.HARNESS }),
  });
}
