import { RETICLE_HYDRATION_ERROR_SIGNAL, TRANSPORT_LIMITS } from '@reticlehq/core';

/**
 * React hydration-mismatch capture. A mismatch — server-rendered markup disagreeing with the
 * client's first render — is reported by React as a *recoverable* error, not thrown: React discards the
 * SSR DOM and re-renders on the client, so the page "looks fine" while handlers/form-state/scroll were
 * silently lost. Invisible to DOM/network/console; only an in-app hook sees it. Pass `reticleOnRecoverableError`
 * to `hydrateRoot(el, App, { onRecoverableError })` and a mismatch surfaces on the signal channel.
 * Pure classifier + shaper are unit-tested; the handler is thin glue that emits via the SDK if present.
 */

const MAX_STACK_LEN = TRANSPORT_LIMITS.MAX_STACK_LENGTH;

/** Minified React error codes that denote a hydration mismatch (react.dev/errors/<code>). */
const HYDRATION_ERROR_CODES: ReadonlySet<string> = new Set([
  '418',
  '419',
  '420',
  '421',
  '422',
  '423',
  '424',
  '425',
]);

function cap(value: string | undefined): string | undefined {
  if (value === undefined || 0 === value.length) return undefined;
  return value.length > MAX_STACK_LEN ? value.slice(0, MAX_STACK_LEN) : value;
}

/**
 * Whether a recoverable error is a hydration mismatch. React phrases these with "hydrat"/"does not match
 * server-rendered" in dev, and as `Minified React error #<code>` for the hydration codes in prod.
 */
export function isHydrationMismatch(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/hydrat/i.test(message)) return true;
  if (/does not match (the )?server-rendered/i.test(message)) return true;
  const minified = /Minified React error #(\d+)/.exec(message);
  return minified !== null && minified[1] !== undefined && HYDRATION_ERROR_CODES.has(minified[1]);
}

export interface HydrationErrorData {
  message: string;
  stack?: string;
  componentStack?: string;
}

/** Pure: shape a hydration mismatch into the reported payload (message + capped stacks). */
export function buildHydrationErrorData(
  error: unknown,
  errorInfo?: { componentStack?: string | null },
): HydrationErrorData {
  const message = error instanceof Error ? error.message : String(error);
  const stack = cap(error instanceof Error ? error.stack : undefined);
  const componentStack = cap(errorInfo?.componentStack ?? undefined);
  return {
    message,
    ...(stack === undefined ? {} : { stack }),
    ...(componentStack === undefined ? {} : { componentStack }),
  };
}

/**
 * Pass to React 19 `hydrateRoot(el, App, { onRecoverableError })`. Emits ONLY hydration mismatches on the
 * signal channel — other recoverable errors are React's normal self-healing and not a Reticle finding.
 */
export function reticleOnRecoverableError(
  error: unknown,
  errorInfo?: { componentStack?: string | null },
): void {
  if (!isHydrationMismatch(error)) return;
  const data = buildHydrationErrorData(error, errorInfo);
  const instance = (
    globalThis as {
      __reticleInstance?: { signal?: (name: string, data: Record<string, unknown>) => void };
    }
  ).__reticleInstance;
  instance?.signal?.(RETICLE_HYDRATION_ERROR_SIGNAL, { ...data });
}
