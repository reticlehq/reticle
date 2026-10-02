import { RETICLE_ERROR_BOUNDARY_SIGNAL, TRANSPORT_LIMITS } from '@reticlehq/core';

/**
 * React error-boundary capture, dev-only). A boundary that catches and swallows renders a fallback
 * that "looks fine" while the feature is broken — invisible to DOM/network/console channels. React 19's
 * `createRoot(el, { onCaughtError })` reports every boundary catch; pass `reticleOnCaughtError` there and
 * the catch surfaces on the signal channel (the SDK's public emit surface). Pure formatter is unit-tested;
 * the handler is thin glue that emits via the SDK instance if present.
 */

const MAX_STACK_LEN = TRANSPORT_LIMITS.MAX_STACK_LENGTH;

export interface ErrorBoundaryData {
  message: string;
  stack?: string;
  componentStack?: string;
}

function cap(value: string | undefined): string | undefined {
  if (value === undefined || 0 === value.length) return undefined;
  return value.length > MAX_STACK_LEN ? value.slice(0, MAX_STACK_LEN) : value;
}

/** Pure: shape a boundary catch into the reported payload (message + capped stacks). */
export function buildErrorBoundaryData(
  error: unknown,
  errorInfo?: { componentStack?: string | null },
): ErrorBoundaryData {
  const message = error instanceof Error ? error.message : String(error);
  const stack = cap(error instanceof Error ? error.stack : undefined);
  const componentStack = cap(errorInfo?.componentStack ?? undefined);
  return {
    message,
    ...(stack === undefined ? {} : { stack }),
    ...(componentStack === undefined ? {} : { componentStack }),
  };
}

/** Pass to React 19 `createRoot(el, { onCaughtError })`. Emits the catch on the signal channel. */
export function reticleOnCaughtError(
  error: unknown,
  errorInfo?: { componentStack?: string | null },
): void {
  const data = buildErrorBoundaryData(error, errorInfo);
  const instance = (
    globalThis as {
      __reticleInstance?: { signal?: (name: string, data: Record<string, unknown>) => void };
    }
  ).__reticleInstance;
  instance?.signal?.(RETICLE_ERROR_BOUNDARY_SIGNAL, { ...data });
}
