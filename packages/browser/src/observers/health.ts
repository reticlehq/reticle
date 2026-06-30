import { EventType, HealthReason, SESSION_HEALTH } from '@reticle/protocol';
import { nativeSetInterval } from '../timers/native-timers.js';
import type { Emit, Teardown } from './types.js';

function snapshotHealth(): { hidden: boolean; focused: boolean } {
  return {
    hidden: document.visibilityState === 'hidden',
    focused: document.hasFocus(),
  };
}

/**
 * Report page visibility/focus immediately on change + a lightweight native heartbeat.
 * Lets the bridge know whether the tab is foregrounded so the agent never drives a throttled
 * tab blind. Uses a native (pre-bound) timer so a frozen app clock (reticle_clock) never stalls it.
 */
export function installHealth(emit: Emit): Teardown {
  const report = (reason: HealthReason): void => {
    emit(EventType.PAGE_HEALTH, { ...snapshotHealth(), reason });
  };

  const onVisibility = (): void => report(HealthReason.VISIBILITY);
  const onFocus = (): void => report(HealthReason.FOCUS);
  const onBlur = (): void => report(HealthReason.BLUR);

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);

  report(HealthReason.INITIAL); // baseline so the server knows state before the first change
  const stopHeartbeat = nativeSetInterval(
    () => report(HealthReason.HEARTBEAT),
    SESSION_HEALTH.HEARTBEAT_MS,
  );

  return () => {
    stopHeartbeat();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
  };
}
