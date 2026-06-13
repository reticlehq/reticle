// Fake clock: patch the APP's setTimeout/setInterval/Date.now/performance.now so the agent
// can deterministically advance time (toasts, debounces, auto-dismiss, commit-on-blur).
// We do NOT patch requestAnimationFrame/microtasks/MessageChannel — React's scheduler relies
// on those, and freezing them would stall the page. Opt-in + reversible.

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

let installed = false;
let virtualNow = 0;
let realBase = 0;
let seq = 1;
let tasks: Task[] = [];
let originals: Originals | null = null;

export function isClockFrozen(): boolean {
  return installed;
}

export function freezeClock(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  virtualNow = 0;
  realBase = Date.now();
  originals = {
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
    dateNow: Date.now,
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

  window.setTimeout = ((cb: () => void, delay = 0) =>
    schedule(cb, delay)) as unknown as typeof window.setTimeout;
  window.clearTimeout = ((id: number) => cancel(id)) as unknown as typeof window.clearTimeout;
  window.setInterval = ((cb: () => void, delay = 0) =>
    schedule(cb, delay, Math.max(1, delay))) as unknown as typeof window.setInterval;
  window.clearInterval = ((id: number) => cancel(id)) as unknown as typeof window.clearInterval;
  // Note: we deliberately do NOT patch performance.now — React 19's scheduler uses it to
  // flush updates, and freezing it stalls re-renders. setTimeout/Date.now cover app timers.
  Date.now = () => realBase + virtualNow;
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
      tasks.push({ ...next, id: seq++, time: virtualNow + next.interval });
    }
  }
  virtualNow = target;
}

export function resetClock(): void {
  if (!installed || originals === null) return;
  window.setTimeout = originals.setTimeout;
  window.clearTimeout = originals.clearTimeout;
  window.setInterval = originals.setInterval;
  window.clearInterval = originals.clearInterval;
  Date.now = originals.dateNow;
  originals = null;
  tasks = [];
  installed = false;
  virtualNow = 0;
}
