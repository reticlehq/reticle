// Fake clock: patch the APP's setTimeout/setInterval/Date.now/performance.now so the agent
// can deterministically advance time (toasts, debounces, auto-dismiss, commit-on-blur).
// We do NOT patch requestAnimationFrame/microtasks/MessageChannel — React's scheduler relies
// on those, and freezing them would stall the page. Opt-in + reversible.

import { requireCapturedMethod } from '../util/captured-method.js';
import { captureMethod } from '../patching/capture-method.js';

interface Task {
  id: number;
  time: number;
  cb: () => void;
  interval?: number | undefined;
}

interface Originals {
  setTimeout: typeof window.setTimeout;
  clearTimeout: typeof window.clearTimeout;
  setInterval: typeof window.setInterval;
  clearInterval: typeof window.clearInterval;
  dateNow: () => number;
}

/**
 * How long a frozen clock may stand untouched before the SDK hands the page its real time back.
 *
 * Freezing is a step inside an agent's turn — freeze, advance, assert — and every one of those hops
 * is seconds. The failure this bounds is the agent simply stopping: the socket stays open (so
 * `onConnectionLost` never fires), nothing ever advances the virtual clock, and the developer's page
 * keeps `Date.now()` pinned forever. Every lodash debounce/throttle reads `now - lastCall === 0`, so
 * search boxes, autosave, polling and auto-dismiss are dead until a reload, with nothing on screen
 * explaining why.
 *
 * Two minutes is far longer than any legitimate gap between an agent's own clock commands, and short
 * enough that a person who tabs back to their app is not left holding a stopped one. Auto-restoring
 * costs the agent nothing it cannot redo, and loses no work: `resetClock` re-arms everything queued
 * during the freeze onto real timers.
 */
export const FREEZE_WATCHDOG_MS = 120_000;

let installed = false;
let virtualNow = 0;
let realBase = 0;
let seq = 1;
let tasks: Task[] = [];
let originals: Originals | null = null;
let watchdog: number | undefined;
/** The functions WE put in the timer slots, so teardown can tell ours from a later wrapper's. */
let ourFakes: Partial<Originals> = {};

/**
 * (Re)arm the deadman on the page's REAL setTimeout.
 *
 * Deliberately not `window.setTimeout`, which is the fake we just installed — scheduling the
 * watchdog there would queue it into a clock only the agent can advance, i.e. exactly the thing that
 * has stopped happening.
 */
function armWatchdog(): void {
  if (null === originals) return;
  const natives = originals;
  const clear = natives.clearTimeout.bind(window);
  if (watchdog !== undefined) clear(watchdog);
  watchdog = natives.setTimeout.bind(window)(() => {
    watchdog = undefined;
    resetClock();
  }, FREEZE_WATCHDOG_MS);
}

export function isClockFrozen(): boolean {
  return installed;
}

export function freezeClock(): void {
  if (installed || 'undefined' === typeof window) return;
  installed = true;
  virtualNow = 0;
  realBase = Date.now();
  // Captured as stored VALUES, so teardown restores the same function objects the page had. See
  // capturedMethod: these are deliberate unbound captures and the descriptor read says so.
  originals = {
    setTimeout: requireCapturedMethod<typeof window.setTimeout>(window, 'setTimeout'),
    clearTimeout: requireCapturedMethod<typeof window.clearTimeout>(window, 'clearTimeout'),
    setInterval: requireCapturedMethod<typeof window.setInterval>(window, 'setInterval'),
    clearInterval: requireCapturedMethod<typeof window.clearInterval>(window, 'clearInterval'),
    dateNow: requireCapturedMethod<typeof Date.now>(Date, 'now'),
  };

  const schedule = (cb: () => void, delay: number, interval?: number): number => {
    const id = seq;
    seq += 1;
    tasks.push({ id, time: virtualNow + Math.max(0, delay), cb, interval });
    return id;
  };
  const cancel = (id: number): void => {
    tasks = tasks.filter((t) => t.id !== id);
  };

  // The trailing arguments are part of the signature: `setTimeout(cb, ms, a, b)` calls `cb(a, b)`.
  // The old two-parameter form dropped them silently — the `as unknown as` cast is what let a fake
  // with the wrong arity stand in for the real thing — so every callback written that way saw
  // `undefined` for the whole freeze. Bound here rather than at fire time so a later mutation of the
  // args array cannot change what the callback receives.
  const withArgs =
    (cb: (...args: unknown[]) => void, args: unknown[]): (() => void) =>
    () => {
      cb(...args);
    };
  window.setTimeout = ((cb: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) =>
    schedule(withArgs(cb, args), delay)) as unknown as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => cancel(id)) as unknown as typeof window.clearTimeout;
  window.setInterval = ((cb: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) =>
    schedule(
      withArgs(cb, args),
      delay,
      Math.max(1, delay),
    )) as unknown as typeof window.setInterval;
  window.clearInterval = ((id: number) => cancel(id)) as unknown as typeof window.clearInterval;
  // Read back through captureMethod: these are stored function values we are holding to compare by
  // identity later, which is exactly the intent that helper exists to state.
  ourFakes = {
    setTimeout: captureMethod(window, 'setTimeout'),
    clearTimeout: captureMethod(window, 'clearTimeout'),
    setInterval: captureMethod(window, 'setInterval'),
    clearInterval: captureMethod(window, 'clearInterval'),
  };
  // Note: we deliberately do NOT patch performance.now — React 19's scheduler uses it to
  // flush updates, and freezing it stalls re-renders. setTimeout/Date.now cover app timers.
  Date.now = () => realBase + virtualNow;
  ourFakes.dateNow = captureMethod(Date, 'now');
  armWatchdog();
}

/** Run all timers due within the next `ms` of virtual time, in order. */
export function advanceClock(ms: number): void {
  if (!installed) return;
  const target = virtualNow + Math.max(0, ms);
  let guard = 0;
  for (;;) {
    guard += 1;
    if (guard > 100000) break;
    const due = tasks.filter((t) => t.time <= target).sort((a, b) => a.time - b.time);
    const next = due[0];
    if (next === undefined) break;
    tasks = tasks.filter((t) => t !== next);
    virtualNow = next.time;
    next.cb();
    if (next.interval !== undefined) {
      // Reschedule under the SAME id — a real setInterval keeps one id for its whole life. Minting a
      // fresh id here (an earlier `id: seq++`) meant the app still held the original id, so its own
      // clearInterval(id) after the first tick matched nothing and the interval fired forever.
      tasks.push({ ...next, time: virtualNow + next.interval });
    }
  }
  virtualNow = target;
  // The agent is still here, so the deadman starts over.
  armWatchdog();
}

/**
 * Restore the real timers AND hand back everything the app queued while frozen.
 *
 * The queue used to be discarded (`tasks = []`). Restoring the native functions is only half the job:
 * the callbacks the app scheduled during the freeze live in the virtual queue, and dropping them leaves
 * the app quietly broken in a new way — a toast that never dismisses, a retry that never fires, a
 * session-expiry check that never runs. `Date.now()` and future timers look healthy, so nothing points
 * at the cause. That matters most on the path this is called from: an agent freezes the clock, the
 * bridge dies, and the developer is left with an app that was never un-frozen deliberately.
 *
 * Pending work is re-scheduled onto REAL timers with its remaining virtual delay (a 5s toast frozen 2s
 * in still has ~3s to go), and the ids the app is holding keep working — see the translation note.
 */
export function resetClock(): void {
  if (!installed || null === originals) return;
  const natives = originals;
  const pending = tasks;
  if (watchdog !== undefined) {
    natives.clearTimeout.bind(window)(watchdog);
    watchdog = undefined;
  }
  // Restore ONLY the slots that still hold OUR fake. A router, a Sentry shim or the app's own test
  // harness may have wrapped a timer AFTER the freeze; writing the native back over it would
  // silently uninstall their instrumentation — the rule route.ts states for history.
  const fakes = ourFakes;
  ourFakes = {};
  if (window.setTimeout === fakes.setTimeout) window.setTimeout = natives.setTimeout;
  if (window.clearTimeout === fakes.clearTimeout) window.clearTimeout = natives.clearTimeout;
  if (window.setInterval === fakes.setInterval) window.setInterval = natives.setInterval;
  if (window.clearInterval === fakes.clearInterval) window.clearInterval = natives.clearInterval;
  if (Date.now === fakes.dateNow) Date.now = natives.dateNow;
  const resumeFrom = virtualNow;
  originals = null;
  tasks = [];
  installed = false;
  virtualNow = 0;
  if (0 === pending.length) return;

  // Re-arm the app's pending work onto REAL timers, translating ids as we go.
  //
  // The app is still holding the VIRTUAL id it was handed while frozen; a native re-arm returns a
  // different one. Without translation the app's own `clearTimeout(id)` would fail to cancel the
  // re-armed callback AND would cancel whichever unrelated native timer happens to hold that id — both
  // id spaces start at 1, so the collision is likely, not theoretical. An earlier version dropped
  // intervals to dodge this and re-armed timeouts anyway, which has the identical hazard: a component
  // that does `const t = setTimeout(hide, 5000); return () => clearTimeout(t)` cannot cancel `hide`,
  // so it fires on an unmounted component.
  //
  // So keep a translation map and a clear-shim for exactly as long as re-armed work is outstanding.
  // Nothing is dropped, and the app's handles keep working.
  // Bound to `window`, not called off `natives`. A timer native invoked with any other receiver
  // throws `TypeError: Illegal invocation` in a real browser — and `natives.setTimeout(...)` passes
  // `natives`. jsdom does not enforce the receiver, so every unit test here passed while the browser
  // threw on the one path that matters: re-arming work the app queued during the freeze. The early
  // return above means it only fires when something IS pending, which is exactly when this function
  // has a job to do. Caught by `bench/harness/clock-timetravel.mjs` driving real Chromium.
  const nativeSetTimeout = natives.setTimeout.bind(window);
  const nativeSetInterval = natives.setInterval.bind(window);

  const reArmed = new Map<number, number>();
  // Filled by installTranslatingClears below, read by `done` only after a timer has fired — i.e.
  // always after the shims exist.
  const shims: { current?: Pick<Originals, 'clearTimeout' | 'clearInterval'> } = {};
  const done = (virtualId: number): void => {
    reArmed.delete(virtualId);
    if (0 === reArmed.size && shims.current !== undefined) restoreRawClears(natives, shims.current);
  };
  for (const task of pending) {
    if (task.interval !== undefined) {
      reArmed.set(task.id, nativeSetInterval(task.cb, task.interval));
    } else {
      reArmed.set(
        task.id,
        nativeSetTimeout(
          () => {
            done(task.id);
            task.cb();
          },
          Math.max(0, task.time - resumeFrom),
        ),
      );
    }
  }
  shims.current = installTranslatingClears(reArmed, natives, done);
}

/** Route a clear() for a re-armed virtual id to its real native id; everything else passes through. */
function installTranslatingClears(
  reArmed: Map<number, number>,
  natives: Originals,
  done: (virtualId: number) => void,
): Pick<Originals, 'clearTimeout' | 'clearInterval'> {
  // `.bind(window)` for the same reason as the re-arm above: a bare `rawClear(id)` reaches the DOM
  // with the wrong receiver and throws `Illegal invocation` in a real browser.
  const translate = (rawClear: (id?: number) => void) => {
    const clear = rawClear.bind(window);
    return ((id: number): void => {
      const nativeId = reArmed.get(id);
      if (nativeId === undefined) {
        clear(id);
        return;
      }
      clear(nativeId);
      done(id);
    }) as unknown as typeof window.clearTimeout;
  };
  window.clearTimeout = translate(natives.clearTimeout);
  window.clearInterval = translate(natives.clearInterval);
  return {
    clearTimeout: captureMethod(window, 'clearTimeout'),
    clearInterval: captureMethod(window, 'clearInterval'),
  };
}

/** Drop the shim once no re-armed work is outstanding — it costs nothing to remove and one hop to keep. */
function restoreRawClears(
  natives: Originals,
  shims: Pick<Originals, 'clearTimeout' | 'clearInterval'>,
): void {
  // Only if the slot still holds the shim WE installed, for the same reason resetClock checks.
  if (window.clearTimeout === shims.clearTimeout) window.clearTimeout = natives.clearTimeout;
  if (window.clearInterval === shims.clearInterval) window.clearInterval = natives.clearInterval;
}
