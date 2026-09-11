/**
 * An empty tree with uncaught errors beside it is a crashed app, not a page that has not rendered.
 *
 * `reticle_snapshot` returning `{ nodes: 0 }` is indistinguishable from "the view has not rendered
 * yet", which is the far more common reading and the wrong one to act on. From the field: an
 * unhandled throw in a commit phase unmounted the React root, the page went white, and the snapshot
 * came back with an empty tree and `presentRegions` listing only Reticle's own dialogs. The reporter
 * took a screenshot, then read `reticle_console`, and found five `Uncaught Error` entries -- about
 * fifteen tool calls after the crash (#899).
 *
 * `noteHiddenPage` already covers the hidden cause and #672's fix covers the hidden-on-a-full-page
 * cause. A crashed root is a third cause with the same symptom, and it is the one that means
 * something is badly wrong right now.
 *
 * Deliberately NOT framework-specific. The condition is "the tree is empty and the window carries
 * uncaught errors", which holds for React, Vue, Svelte and a hand-written app alike; nothing here
 * looks for a React root, because the tell that matters is the pair, not the framework.
 *
 * And deliberately NOT a diagnosis. The note says the app MAY have crashed and hands over the
 * channel that knows -- it does not claim to have read the error. A note that overclaimed would be
 * the same kind of confident wrong answer as the bare zero it replaces.
 */

import { EventType } from '@reticlehq/core';
import type { ReticleEvent } from '@reticlehq/core';

/** How many error messages to name before the note stops being a note. */
const MAX_NAMED = 2;

/** Enough of a message to recognise it; this is read in a tool result, not a log. */
const MAX_MESSAGE = 120;

function truncate(value: string): string {
  return value.length > MAX_MESSAGE ? `${value.slice(0, MAX_MESSAGE)}…` : value;
}

/** The uncaught errors in this window, most recent last, as their messages. */
export function uncaughtMessages(events: readonly ReticleEvent[]): string[] {
  const messages: string[] = [];
  for (const event of events) {
    if (event.type !== EventType.ERROR_UNCAUGHT) continue;
    const message = event.data['message'];
    messages.push(
      'string' === typeof message && message.length > 0 ? message : 'an uncaught error',
    );
  }
  return messages;
}

/**
 * The note for an empty tree with uncaught errors beside it, or undefined when there is none to give.
 *
 * Undefined matters as much as the sentence: an empty tree on a page that threw nothing is an
 * ordinary "not rendered yet", and a note that fired on every empty snapshot would stop being read
 * exactly where it is needed.
 */
export function crashedRootNote(events: readonly ReticleEvent[]): string | undefined {
  const messages = uncaughtMessages(events);
  if (0 === messages.length) return undefined;
  // The LAST errors, not the first: a crash is the most recent thing that happened, and a page that
  // logged an unrelated throw on load would otherwise name that one instead.
  const named = messages.slice(-MAX_NAMED).map((message) => JSON.stringify(truncate(message)));
  const count = messages.length;
  const plural = 1 === count ? 'error' : 'errors';
  return (
    `this is probably NOT a page that has not rendered yet: the tree is empty AND ${String(count)} ` +
    `uncaught ${plural} ${1 === count ? 'was' : 'were'} logged in this session (${named.join(', ')}), ` +
    `which is what an app that threw during render and unmounted its root looks like. Read ` +
    `reticle_console for the full errors and their stacks before treating this as a timing problem — ` +
    `retrying or waiting will not fix a crashed root.`
  );
}
