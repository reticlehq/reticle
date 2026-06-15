import { REDACTED_VALUE, TRANSPORT_LIMITS } from '@syrin/iris-protocol';

const TRUNCATED_VALUE = '[TRUNCATED]';
const UNSERIALIZABLE_VALUE = '[UNSERIALIZABLE]';
const OMIT_VALUE = Symbol('omit');
const MAX_KEY_LENGTH = 256;
const MAX_TOTAL_CHARACTERS = Math.floor(TRANSPORT_LIMITS.MAX_MESSAGE_BYTES / 8);
const MAX_TOTAL_NODES = TRANSPORT_LIMITS.MAX_COLLECTION_ITEMS * 5;

const SENSITIVE_KEY =
  /password|passwd|passcode|secret|token|authorization|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|credit[-_]?card|card[-_]?number|cvv|cvc|ssn/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

interface SanitizeState {
  readonly seen: WeakSet<object>;
  remainingCharacters: number;
  nodes: number;
}

function boundedString(value: string, state: SanitizeState, max: number): string {
  const allowed = Math.max(0, Math.min(max, state.remainingCharacters));
  if (value.length <= allowed) {
    state.remainingCharacters -= value.length;
    return value;
  }
  const truncated =
    allowed <= TRUNCATED_VALUE.length
      ? TRUNCATED_VALUE.slice(0, allowed)
      : `${value.slice(0, allowed - TRUNCATED_VALUE.length)}${TRUNCATED_VALUE}`;
  state.remainingCharacters -= truncated.length;
  return truncated;
}

function sanitize(value: unknown, state: SanitizeState, depth: number, key?: string): unknown {
  if (key !== undefined && isSensitiveKey(key)) return REDACTED_VALUE;
  if (depth > TRANSPORT_LIMITS.MAX_SERIALIZE_DEPTH || state.nodes >= MAX_TOTAL_NODES) {
    return TRUNCATED_VALUE;
  }
  state.nodes += 1;

  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return boundedString(
      value,
      state,
      key?.toLowerCase() === 'error'
        ? TRANSPORT_LIMITS.MAX_ERROR_LENGTH
        : TRANSPORT_LIMITS.MAX_STRING_LENGTH,
    );
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return OMIT_VALUE;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: boundedString(value.name, state, 256),
      message: boundedString(value.message, state, TRANSPORT_LIMITS.MAX_ERROR_LENGTH),
    };
  }
  if (state.seen.has(value)) return '[CIRCULAR]';

  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.slice(0, TRANSPORT_LIMITS.MAX_COLLECTION_ITEMS).map((item) => {
        const sanitized = sanitize(item, state, depth + 1);
        return sanitized === OMIT_VALUE ? null : sanitized;
      });
    }

    const out = Object.create(null) as Record<string, unknown>;
    for (const rawKey of Object.keys(value).slice(0, TRANSPORT_LIMITS.MAX_OBJECT_KEYS)) {
      const safeKey = boundedString(rawKey, state, MAX_KEY_LENGTH);
      try {
        const sanitized = sanitize(
          (value as Record<string, unknown>)[rawKey],
          state,
          depth + 1,
          rawKey,
        );
        if (sanitized !== OMIT_VALUE) out[safeKey] = sanitized;
      } catch {
        out[safeKey] = UNSERIALIZABLE_VALUE;
      }
    }
    return out;
  } finally {
    state.seen.delete(value);
  }
}

/** Convert arbitrary app state into a bounded, redacted JSON-compatible value. */
export function sanitizeForTransport(value: unknown): unknown {
  const sanitized = sanitize(
    value,
    {
      seen: new WeakSet(),
      remainingCharacters: MAX_TOTAL_CHARACTERS,
      nodes: 0,
    },
    0,
  );
  return sanitized === OMIT_VALUE ? null : sanitized;
}

/** Serialize without allowing cycles, BigInt, getters, or secrets to break the transport. */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(sanitizeForTransport(value));
  } catch {
    return JSON.stringify(UNSERIALIZABLE_VALUE);
  }
}
