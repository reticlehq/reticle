/**
 * One place Reticle says what happened, and everything that wants to know listens here.
 *
 * Two surfaces sit on this and neither is the mechanism: `onReticleEvent` hands the payload to code
 * running in this process, and the command runner spawns whatever `.reticle/hooks.json` names. They
 * are adapters.
 *
 * ── THE ONE RULE ────────────────────────────────────────────────────────────────────────────────
 * A HOOK MUST NEVER BREAK OR SLOW A VERIFICATION. The verdict is the product; a user's notification
 * script is not, and a product where adding a Slack webhook can turn a passing check into a failing
 * one is a product where the honest advice is to not use hooks. So `emit` is synchronous, returns
 * `void`, awaits nothing, and cannot throw: a subscriber that throws is caught, a subscriber that
 * hangs is left hanging, and the caller has already moved on either way.
 *
 * This is the same discipline the sync daemon states for itself — "nothing here is awaited by a tool
 * call" — and for the same reason.
 *
 * ── WHY A MODULE-LEVEL BUS ──────────────────────────────────────────────────────────────────────
 * Deliberately process-global, unlike the snapshot cache which was just moved off module scope for
 * being shared when it should have been per-client. The opposite is true here: a hook is a property
 * of THE MACHINE's configuration, not of whichever agent happens to be connected, and a user who
 * writes `bug_found` in their repo means "when Reticle finds a bug", not "when the third MCP client
 * to attach finds a bug". Scoping this per connection would silently drop events for a repo whose
 * daemon was started by someone else.
 */

import { HookPayloadSchema, type HookEventName, type HookPayload } from '@reticlehq/core/hooks';
import { log } from '@/log.js';

/** What a listener is handed. Never awaited — see the rule above. */
export type HookListener = (payload: HookPayload) => void;

/** Listeners by event, plus the ones that asked for everything. */
const listeners = new Map<HookEventName, Set<HookListener>>();
const everyEvent = new Set<HookListener>();

/**
 * Errors already reported, so a broken hook says so once instead of once per verdict.
 *
 * A laptop with a typo in `hooks.json` would otherwise write the same line a few hundred times in a
 * morning and teach its owner to ignore the log — the failure mode the sync daemon calls out by
 * name, arrived at independently here because the shape of the problem is identical.
 */
const reported = new Set<string>();

function reportOnce(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const key = `${context}:${message}`;
  if (reported.has(key)) return;
  reported.add(key);
  log(`hook failed (${context}): ${message}`);
}

/**
 * Listen for one event, or for every event when `event` is omitted.
 *
 * Returns the unsubscribe function rather than taking an `off(event, fn)` pair, because the pair
 * requires the caller to keep the identical function reference and silently does nothing when they
 * do not — a leak that looks exactly like working code.
 */
export function onHook(event: HookEventName | undefined, listener: HookListener): () => void {
  if (event === undefined) {
    everyEvent.add(listener);
    return () => {
      everyEvent.delete(listener);
    };
  }
  const set = listeners.get(event) ?? new Set<HookListener>();
  set.add(listener);
  listeners.set(event, set);
  return () => {
    set.delete(listener);
  };
}

/**
 * Say that something happened.
 *
 * VALIDATED before delivery, and that is not ceremony: the payload is built from internal objects at
 * each call site, and parsing it here is what stops a field nobody meant to publish from reaching a
 * consumer. zod strips unknown keys, so a caller that spreads a wider internal record into a payload
 * gets only the declared fields out — which is the mechanism the secret-shape guard in core relies
 * on rather than trusting every future call site to be careful.
 *
 * An INVALID payload is dropped and reported once. Throwing would push a bug in our own event
 * construction into the caller's verdict path, which is the one thing this file promises not to do.
 */
export function emitHook(payload: HookPayload): void {
  const parsed = HookPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    reportOnce(`emit:${String(payload.event)}`, parsed.error.message);
    return;
  }
  const safe = parsed.data;
  const targets = [...(listeners.get(safe.event) ?? []), ...everyEvent];
  for (const listener of targets) {
    try {
      listener(safe);
    } catch (error) {
      reportOnce(`listener:${safe.event}`, error);
    }
  }
}

/** How many listeners an event has. For the daemon's own status output, and for tests. */
export function hookListenerCount(event: HookEventName): number {
  return (listeners.get(event)?.size ?? 0) + everyEvent.size;
}

/** Drop every listener. Tests, and a daemon tearing down its own wiring. */
export function resetHooks(): void {
  listeners.clear();
  everyEvent.clear();
  reported.clear();
}
