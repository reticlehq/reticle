import { EventType, REDACTED_VALUE, StorageArea } from '@reticlehq/core';
import { isSensitiveKey } from '../security/serialization.js';
import { observeSafely, observeValue, type Emit, type Teardown } from './types.js';

/** The three readable client-side storage areas. httpOnly cookies are invisible to JS by design. */
export interface StorageSnapshot {
  local: Record<string, string>;
  session: Record<string, string>;
  cookies: Record<string, string>;
}

/** Accessing localStorage/sessionStorage throws in a sandboxed iframe / disabled-storage context. */
function safeArea(get: () => Storage): Storage | null {
  try {
    return get();
  } catch {
    return null;
  }
}

function readArea(storage: Storage | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (null === storage) return out;
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (null === key) continue;
    // Redact credential-bearing keys (token/session/password/…) so auth state never leaks verbatim.
    out[key] = isSensitiveKey(key) ? REDACTED_VALUE : (storage.getItem(key) ?? '');
  }
  return out;
}

function readCookies(): Record<string, string> {
  const out: Record<string, string> = {};
  // Reading document.cookie can throw (SecurityError) in a sandboxed / cookie-disabled context — guard
  // it the same way safeArea guards localStorage, so one bad area never crashes the whole STORAGE read.
  let raw = '';
  try {
    raw = typeof document !== 'undefined' ? document.cookie : '';
  } catch {
    return out;
  }
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (-1 === eq) continue;
    const key = part.slice(0, eq).trim();
    if ('' === key) continue;
    if (isSensitiveKey(key)) {
      out[key] = REDACTED_VALUE;
      continue;
    }
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

/**
 * Read client-side storage on demand (the STORAGE_READ command). Powers `reticle_storage` — the
 * agent verifies "token persisted after login", "cart survived reload", "logout cleared the session"
 * from the app's real storage rather than inferring it from the DOM. `area` scopes to one area; omit
 * for all three. Sensitive keys are redacted; httpOnly cookies are unreadable by design (documented).
 */
export function readStorage(area?: string): StorageSnapshot | Record<string, string> {
  if (area === StorageArea.LOCAL) return readArea(safeArea(() => window.localStorage));
  if (area === StorageArea.SESSION) return readArea(safeArea(() => window.sessionStorage));
  if ('cookies' === area) return readCookies();
  return {
    local: readArea(safeArea(() => window.localStorage)),
    session: readArea(safeArea(() => window.sessionStorage)),
    cookies: readCookies(),
  };
}

/** Redact a value when its key is credential-bearing — the same rule the pull path applies. */
function redactFor(key: string, value: string | null): string | undefined {
  if (null === value) return undefined;
  return isSensitiveKey(key) ? REDACTED_VALUE : value;
}

type SetItemFn = (this: Storage, key: string, value: string) => void;
type RemoveItemFn = (this: Storage, key: string) => void;
type ClearFn = (this: Storage) => void;

/**
 * Observe storage WRITES (not just reads): patch Storage.setItem/removeItem so a token persisted, a
 * cart updated, or a session cleared emits a STORAGE_CHANGE {area, key, old?, new?} diff — the "before"
 * the pull path can never see. localStorage and sessionStorage share one prototype, so `this` inside the
 * patch identifies the area. The native originals are read off the prototype descriptor (not a bare
 * method access) and re-dispatched via `.call(this)`. Fully reversible; values redacted like the reads.
 */
export function installStorage(emit: Emit): Teardown {
  if ('undefined' === typeof Storage) return () => undefined;
  const proto = Storage.prototype;
  const origSet = Object.getOwnPropertyDescriptor(proto, 'setItem')?.value as SetItemFn | undefined;
  const origRemove = Object.getOwnPropertyDescriptor(proto, 'removeItem')?.value as
    RemoveItemFn | undefined;
  const origClear = Object.getOwnPropertyDescriptor(proto, 'clear')?.value as ClearFn | undefined;
  if (origSet === undefined || origRemove === undefined || origClear === undefined) {
    return () => undefined;
  }

  // Resolve sessionStorage at CALL time, not once at install. If the property threw during install
  // (a transient sandbox state) the captured reference would be null and every session write would be
  // misreported as `local` for the life of the page. Reads are cheap and safeArea swallows throws.
  const areaOf = (storage: Storage): StorageArea =>
    storage === safeArea(() => window.sessionStorage) ? StorageArea.SESSION : StorageArea.LOCAL;
  const readOld = (storage: Storage, key: string): string | null => {
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  };

  const patchedSetItem = function (this: Storage, key: string, value: string): void {
    // The app's write happens FIRST and outside the guard — it must succeed or fail on its own terms.
    const old = observeValue(() => readOld(this, key)) ?? null;
    origSet.call(this, key, value);
    observeSafely(() => {
      emit(EventType.STORAGE_CHANGE, {
        area: areaOf(this),
        key,
        ...(redactFor(key, old) === undefined ? {} : { old: redactFor(key, old) }),
        new: redactFor(key, value) ?? REDACTED_VALUE,
      });
    });
  };
  proto.setItem = patchedSetItem;

  const patchedRemoveItem = function (this: Storage, key: string): void {
    const old = observeValue(() => readOld(this, key)) ?? null;
    origRemove.call(this, key);
    observeSafely(() => {
      // No `new` field ⇒ the key was removed.
      emit(EventType.STORAGE_CHANGE, {
        area: areaOf(this),
        key,
        ...(redactFor(key, old) === undefined ? {} : { old: redactFor(key, old) }),
      });
    });
  };
  proto.removeItem = patchedRemoveItem;

  const patchedClear = function (this: Storage): void {
    // localStorage.clear() is the most common logout — but it emitted NOTHING, so "logout cleared the
    // session" was unverifiable from the write path. Snapshot the keys BEFORE clearing (the values are
    // gone after), then report each as a removal, reusing the {area, key, old} shape removeItem emits.
    const area = areaOf(this);
    const removed: Array<{ key: string; old: string | null }> = [];
    try {
      for (let i = 0; i < this.length; i += 1) {
        const key = this.key(i);
        if (key !== null) removed.push({ key, old: readOld(this, key) });
      }
    } catch {
      // Enumerating keys can throw in a locked-down context; clear anyway, just without the diff.
    }
    origClear.call(this);
    for (const { key, old } of removed) {
      observeSafely(() => {
        emit(EventType.STORAGE_CHANGE, {
          area,
          key,
          ...(redactFor(key, old) === undefined ? {} : { old: redactFor(key, old) }),
        });
      });
    }
  };
  proto.clear = patchedClear;

  return () => {
    // Restore only if the slot still holds our wrapper — never uninstall a wrapper the app layered
    // on top of ours after connect().
    if (proto.setItem === patchedSetItem) proto.setItem = origSet;
    if (proto.removeItem === patchedRemoveItem) proto.removeItem = origRemove;
    if (proto.clear === patchedClear) proto.clear = origClear;
  };
}
