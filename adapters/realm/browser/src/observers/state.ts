import { BlindSpotKind, EventType, REDACTED_VALUE } from '@reticlehq/core';
import {
  subscribableStores,
  onStoreRegistered,
  type StoreGetter,
  type StoreSubscribe,
} from '@/registry/stores.js';
import { isSensitiveKey, sanitizeForTransport } from '@/security/serialization.js';
import { observeSafely, type Emit, type Teardown } from './types.js';

interface StateChange {
  path: string;
  old: unknown;
  new: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return 'object' === typeof value && value !== null && !Array.isArray(value);
}

/**
 * Shallow top-level diff of two store states — the keys whose value changed. Immutable updates
 * (Zustand/Redux) replace the changed key's reference, so `Object.is` catches them. Pure; deep-nested
 * diffing behind an unchanged top-level reference is a v2 concern.
 */
export function diffState(prev: unknown, next: unknown): StateChange[] {
  if (!isRecord(prev) || !isRecord(next)) {
    return Object.is(prev, next) ? [] : [{ path: '', old: prev, new: next }];
  }
  const changes: StateChange[] = [];
  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (!Object.is(prev[key], next[key]))
      changes.push({ path: key, old: prev[key], new: next[key] });
  }
  return changes;
}

/** Redact a changed value when its path is credential-bearing, else cap it for transport. */
function project(path: string, value: unknown): unknown {
  return isSensitiveKey(path) ? REDACTED_VALUE : sanitizeForTransport(value);
}

/**
 * Did this "change" actually change anything a reader can see?
 *
 * `diffState` compares top-level values with `Object.is`, which is the right test for the
 * immutable-update libraries it was written for: Zustand and Redux replace the changed key's
 * reference. A cache does the opposite. TanStack Query re-emits an unchanged entry under a NEW
 * object reference on every refetch, so `Object.is` says "changed" and the value on both sides is
 * the same.
 *
 * Nothing downstream can tell those apart, and they accumulate. Reported from the field as
 * `Cannot create a string longer than 0x1fffffe8 characters` -- V8's 512 MB string ceiling, thrown
 * out of the daemon as a raw exception, on a session whose churn the reporter identified as
 * "stateDiffs (TanStack Query caches re-emitting identical from/to snapshots)". A store re-emitting
 * a value it already had is not an event (#985).
 *
 * Compared on the PROJECTED forms, which is both cheaper and more honest than a deep compare of the
 * raw values: projection is what actually travels, it is already size-capped by
 * `sanitizeForTransport`, and two values that project identically are indistinguishable to every
 * reader of this event. The raw pair may still differ in some way nobody can observe, and reporting
 * a difference nobody can observe is exactly what this drops.
 *
 * The caller excludes redacted paths before asking, and must: redaction collapses every credential
 * to one token, so two DIFFERENT secrets present identically and coalescing there would drop a real
 * rotation. This test is only meaningful where the projection is faithful.
 */
function samePresentedValue(oldValue: unknown, newValue: unknown): boolean {
  if (Object.is(oldValue, newValue)) return true;
  try {
    return JSON.stringify(oldValue) === JSON.stringify(newValue);
  } catch {
    // A projected value that will not serialise cannot be compared this way, and a pair we cannot
    // compare must be reported rather than dropped: silence about a real change is the one failure
    // worse than the noise this is removing.
    return false;
  }
}

function safeRead(getter: StoreGetter): unknown {
  try {
    return getter();
  } catch {
    return undefined;
  }
}

/**
 * Subscribe to every registered store that exposed a subscribe method, emitting a STATE_CHANGE per
 * changed top-level path with {name, path, old, new} — automatic diffs, not pull-only readings. Stores
 * without a subscribe fall back to the pull path (reticle_state). Fully reversible.
 */
export function installStoreState(emit: Emit): Teardown {
  const active = new Map<string, () => void>();
  const watch = ([name, getter, subscribe]: [string, StoreGetter, StoreSubscribe]): void => {
    // A re-registration under the same name is the HMR cycle: the store INSTANCE is replaced (new
    // getter + new subscribe). Skipping it — a `seen` guard — would leave the subscription bound to
    // the DEAD getter forever and the live store invisible until a full reload. Rebind: drop the
    // previous subscription for this name, then subscribe the new tuple. Guard that unsubscribe — if
    // it throws (a misbehaving store), the rebind must still proceed.
    try {
      active.get(name)?.();
    } catch {
      /* a faulty unsubscribe must not block re-binding to the new instance */
    }
    let last = safeRead(getter);
    active.set(
      name,
      subscribe(() => {
        // This callback runs INSIDE the app's own notify loop (zustand/Redux iterate their listeners
        // synchronously), so a throw here — from diffing, redacting or emitting an exotic value —
        // unwinds that loop and every listener registered after ours never runs.
        observeSafely(() => {
          const next = safeRead(getter);
          for (const change of diffState(last, next)) {
            const value = project(change.path, change.new);
            const old = project(change.path, change.old);
            // A new reference carrying the value it already had is not a change. See
            // `samePresentedValue` -- this is the accumulator behind #985.
            //
            // NOT on a redacted path. `project` collapses every credential to one token, so both
            // sides present as `[REDACTED]` whether or not the secret changed, and coalescing on
            // that would silently drop a real rotation. The comparison is only meaningful where the
            // projection is faithful.
            if (!isSensitiveKey(change.path) && samePresentedValue(old, value)) continue;
            emit(EventType.STATE_CHANGE, { name, path: change.path, value, old });
          }
          last = next;
        });
      }),
    );
  };
  // Stores already registered...
  for (const entry of subscribableStores()) watch(entry);
  /**
   * Declare an unwatched state channel — and clear it the moment one is watched.
   *
   * With nothing subscribed, every act reports `stateDiffs: []`, which reads as "the app changed no
   * state" when the truth is "nobody was looking". Emitted as a BLIND_SPOT so it travels the path
   * that already exists for everything the layer cannot see: bounding, never impeaching, so no
   * verdict turns UNKNOWN over it.
   */
  if (0 === active.size) {
    emit(EventType.BLIND_SPOT, { kind: BlindSpotKind.UNWATCHED_STATE, count: 1 });
  }
  //...and any registered LATER. The SDK installs observers during connect, but apps call
  // registerStore after that, so without this the common case subscribes to nothing.
  const offRegistered = onStoreRegistered((entry) => {
    const wasDark = 0 === active.size;
    watch(entry);
    // The channel just lit up. A blind spot that is never withdrawn is a permanent lie, and this one
    // is withdrawn in the ordinary case: apps register their stores AFTER connect() installs us.
    if (wasDark && active.size > 0) {
      emit(EventType.BLIND_SPOT, { kind: BlindSpotKind.UNWATCHED_STATE, count: 0 });
    }
  });
  return () => {
    offRegistered();
    for (const unsubscribe of active.values()) {
      try {
        unsubscribe();
      } catch {
        /* one faulty store unsubscribe must not abort tearing the rest down */
      }
    }
    active.clear();
  };
}
