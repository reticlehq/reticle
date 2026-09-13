/**
 * Answer the native dialogs the app opens while RETICLE is driving it, instead of letting them block.
 *
 * `alert`, `confirm` and `prompt` halt the main thread until something answers. Nothing in the page
 * can: the SDK's own message pump runs on that same thread. So one `confirm()` behind a driven click
 * made the tab permanently unresponsive — `reticle_sessions` reported `unresponsive: true`, every
 * `reticle_navigate` including `reload: true, hard: true` timed out at 8000ms, and ending the
 * session did not revive it. The documented recovery opens a DIFFERENT tab, which on the reported
 * session — the only authenticated one — was no recovery at all.
 *
 * Scoped to Reticle's own dispatches, and that scope is the whole safety argument. A dialog a PERSON
 * opened is theirs: they can see it and click it, and answering it for them would change how the app
 * behaves for the human whose page this is. `isSyntheticInput()` already draws exactly that line for
 * the annotator, and it is exact here rather than a heuristic — `confirm()` called from a click
 * handler runs synchronously inside the dispatch that is being counted.
 */

import { EventType } from '@reticlehq/core';
import { observeSafely, type Emit, type Teardown } from './types.js';
import { isSyntheticInput } from '../actions/synthetic/synthetic-input.js';

/**
 * What Reticle answers, per dialog.
 *
 * `confirm` is answered NO and `prompt` is answered with no value, because those are the replies
 * that decline. Guessing in the app's favour would make Reticle the thing that confirmed a deletion
 * nobody approved — and `confirmDangerous` exists precisely so that decision is the caller's,
 * stated up front, rather than something the SDK does on their behalf inside a click.
 *
 * An accept path is deliberately absent for now: a caller who genuinely means "yes" has no way to
 * say so through a native dialog yet. That is a smaller gap than a permanently wedged tab, and it
 * wants its own design — most likely carrying the action's own `confirmDangerous` down to here.
 */
const DECLINED = { alert: undefined, confirm: false, prompt: null } as const;

type DialogKind = keyof typeof DECLINED;

const KINDS: readonly DialogKind[] = ['alert', 'confirm', 'prompt'];

/**
 * The three slots, typed as plain functions so they can be read and written by name.
 *
 * One structural cast rather than `any` per access, and deliberately NOT `requireCapturedMethod`:
 * that helper insists on an OWN property, and `alert`/`confirm`/`prompt` live on `Window.prototype`.
 * Its own-property rule is right for `console`, where an inherited slot means somebody already
 * replaced the object; here inheritance is simply where these have always lived.
 */
type DialogSlots = Record<DialogKind, (...args: unknown[]) => unknown>;

export function installDialogs(emit: Emit): Teardown {
  const slots = window as unknown as DialogSlots;
  const originals = new Map<DialogKind, (...args: unknown[]) => unknown>();
  const patched = new Map<DialogKind, (...args: unknown[]) => unknown>();

  for (const kind of KINDS) {
    const original = slots[kind];
    // A page that has already removed one of these is not a page to patch. Skipping is safer than
    // installing a wrapper with nothing to fall back to for a dialog we decide not to answer.
    if ('function' !== typeof original) continue;
    originals.set(kind, original);
    const callOriginal = original.bind(window);
    const wrapper = (...args: unknown[]): unknown => {
      // Not ours: the person opened it, and it behaves exactly as it always did.
      if (!isSyntheticInput()) return callOriginal(...args);
      const answered = DECLINED[kind];
      const message = args[0];
      // The answer is what the app is waiting on, so observation cannot be allowed to replace it with
      // a throw: the dialog is being answered whether or not the event lands.
      observeSafely(() => {
        emit(EventType.DIALOG_OPENED, {
          kind,
          ...('string' === typeof message ? { message } : {}),
          // `alert` has nothing to answer, so the field is omitted rather than reported as a value.
          ...(answered === undefined ? {} : { answered }),
        });
      });
      return answered;
    };
    patched.set(kind, wrapper);
    slots[kind] = wrapper;
  }

  return () => {
    for (const [kind, original] of originals) {
      // Restore only if the slot still holds OUR wrapper — the same rule installConsole follows, so
      // a logging SDK that wrapped these after connect() keeps its instrumentation on teardown.
      if (slots[kind] === patched.get(kind)) slots[kind] = original;
    }
  };
}
