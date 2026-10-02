/**
 * Should this page be asked for this command at all?
 *
 * A pure decision, kept out of `Session` so it can be argued with directly: the interesting part
 * is not the sending, it is the rule about when not to send, and that rule has a case each way.
 *
 * The protocol says an implementation declares what it can do and refuses everything else, and
 * the whole value of refusing is that it happens BEFORE the action is spent. Without a
 * declaration the only way to discover an unsupported command was to send it and wait: eight
 * seconds, then a timeout whose message is about the page being slow. For a command the page was
 * never going to answer, that reads as an unhealthy application rather than a request it does not
 * serve, and it sends whoever is reading to debug the wrong thing.
 *
 * **The other half matters more.** `commands` is optional, and an SDK too old to declare sends
 * nothing at all. Silence must read as UNKNOWN and never as an empty list -- treating it as
 * "serves nothing" would refuse every command from every older page in the field, which is a far
 * larger failure than the one being prevented. Absence is the reason this is a function with two
 * answers rather than a set lookup at the call site.
 */

import { MessageKind, type CommandResult } from '@reticlehq/core';

/** Why nothing was sent, in a sentence, or undefined when the command should go. */
export function refusalForUndeclared(
  name: string,
  declared: readonly string[] | undefined,
): string | undefined {
  // Too old to say. Unknown, never "nothing".
  if (declared === undefined) return undefined;
  if (declared.includes(name)) return undefined;
  return (
    `this page does not serve "${name}". It declared ${String(declared.length)} command(s) when ` +
    `it connected, and this is not one of them: ${declared.join(', ')}. Nothing was sent, so ` +
    'nothing happened -- this is a refusal, not a failure of the app.'
  );
}

/**
 * The refusal as a finished result, or undefined when the command should be sent.
 *
 * Returns the whole `CommandResult` rather than the sentence, so the caller is two lines and
 * cannot get the envelope subtly wrong -- an `ok: true` refusal would be read as a command that
 * worked, which is the one shape this must never produce.
 */
export function refusedResult(
  name: string,
  declared: readonly string[] | undefined,
  id: string,
): CommandResult | undefined {
  const error = refusalForUndeclared(name, declared);
  return error === undefined
    ? undefined
    : { kind: MessageKind.COMMAND_RESULT, id, ok: false, error };
}
