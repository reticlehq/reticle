/**
 * Every shadow root this SDK has seen created, open or closed.
 *
 * Two problems are solved by the same record.
 *
 * **Observation.** A `MutationObserver` on `documentElement` does NOT cross a shadow boundary, so a
 * click that changes text inside a web component produced an entirely empty observe window. Measured
 * on a console with a shadow-DOM alert badge: the click landed, the badge changed, and `observe`
 * reported zero DOM events — indistinguishable from an app that ignored the click. The DOM observer
 * needs a list of roots to attach to, and no API enumerates them.
 *
 * **Closed roots.** `element.shadowRoot` is null forever for `mode: 'closed'`, so a closed root is
 * unreadable AFTER the fact — but `attachShadow` still RETURNS it to its caller. Patching that call
 * captures the root at the one instant it is exposed. This only works when the SDK is installed
 * before the component upgrades, which is why hosts are tracked individually rather than assumed:
 * whatever was missed is still declared as a blind spot, and only what was genuinely captured stops
 * being one.
 */

import { captureMethod } from '../patching/capture-method.js';

/**
 * How many installs are live.
 *
 * The state below is module-level, and a dev-only SDK gets installed more than once: Vite re-runs the
 * module on hot reload, so `connect()` can run again before the previous instance is torn down.
 * Measured: install, subscribe, install again, tear down the SECOND one — and the FIRST instance's
 * subscribers were gone, so the DOM observer silently stopped being told about new shadow roots for
 * the rest of the session. Shared state must only be cleared by the last install standing.
 */
let installs = 0;

/**
 * Retained shadow roots, weakly.
 *
 * This was a strong `Set` and it never shrank. Measured: a virtualized list that renders and removes
 * 5,000 web-component rows left 5,000 roots retained — each pinning its whole shadow subtree, and
 * pinning its host through `root.host`, so nothing the list discarded could ever be collected. A
 * design system's rows ARE web components, so the most ordinary data-heavy page is the worst case,
 * and this SDK is meant to sit in a dev session all day.
 *
 * Same shape `RefRegistry` already uses for element handles: hold weakly, bound the bookkeeping,
 * sweep the dead entries periodically rather than on every write.
 */
const roots = new Set<WeakRef<ShadowRoot>>();
/**
 * Membership, separately and weakly.
 *
 * The weak entries above are for ENUMERATION and cannot answer "have I seen this root" without
 * dereferencing all of them — which turns every `attachShadow` into a scan of every root so far, and
 * a 5,000-row list into 25 million comparisons. A WeakSet answers it in O(1) and retains nothing.
 */
const known = new WeakSet<ShadowRoot>();
const hosts = new WeakSet<Element>();

/**
 * Bookkeeping ceiling. Weak references make the ROOTS collectable; this bounds the entries pointing
 * at them, which are not. Sized far above any real page's live component count.
 */
export const MAX_TRACKED_ROOTS = 4000;

/** Dead-entry sweeps are O(retained), so they run once per this many roots rather than per root. */
export const SWEEP_EVERY = 250;
let sinceSweep = 0;

/** Drop entries whose root has been collected, then any excess by age (Set keeps insertion order). */
function sweep(): void {
  for (const ref of roots) {
    if (ref.deref() === undefined) roots.delete(ref);
  }
  while (roots.size > MAX_TRACKED_ROOTS) {
    const oldest = roots.values().next();
    if (true === oldest.done) break;
    roots.delete(oldest.value);
  }
}

/** The live roots behind the weak entries. */
function liveRoots(): ShadowRoot[] {
  const out: ShadowRoot[] = [];
  for (const ref of roots) {
    const root = ref.deref();
    if (root !== undefined) out.push(root);
  }
  return out;
}
const listeners = new Set<(root: ShadowRoot) => void>();

type AttachShadow = (this: Element, init: ShadowRootInit) => ShadowRoot;

function record(root: ShadowRoot, host: Element): void {
  // Idempotent. A hot reload leaves one patch wrapping another, so a single `attachShadow` travels
  // through both and reports twice; the initial sweep can also meet a root the patch already caught.
  // Subscribers must see each root exactly once — they attach an observer per root, and counting one
  // twice is how a "reported once" guarantee quietly becomes "reported per install".
  if (known.has(root)) return;
  known.add(root);
  roots.add(new WeakRef(root));
  sinceSweep += 1;
  if (sinceSweep >= SWEEP_EVERY) {
    sinceSweep = 0;
    sweep();
  }
  hosts.add(host);
  for (const listener of listeners) listener(root);
}

/** Shadow roots captured so far. Includes closed roots when the patch was installed in time. */
export function capturedRoots(): readonly ShadowRoot[] {
  return liveRoots();
}

/** Whether this element's shadow root was captured — i.e. whether its contents are reachable. */
export function isCaptured(host: Element): boolean {
  return hosts.has(host);
}

/** The captured root for a host, or null. Non-null for closed roots the patch caught in time. */
export function capturedRootOf(host: Element): ShadowRoot | null {
  if (!hosts.has(host)) return null;
  for (const root of liveRoots()) if (root.host === host) return root;
  return null;
}

/** Run `listener` for every root captured from now on. Returns an unsubscribe. */
export function onShadowRoot(listener: (root: ShadowRoot) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Patch `attachShadow` to record each root as it is created, and sweep the roots that already exist.
 *
 * The sweep can only find OPEN roots (there is no other way in), so a closed root attached before
 * install stays unreachable — correctly, and it is declared as such.
 */
export function installShadowRegistry(): () => void {
  const proto = Element.prototype;
  // Through captureMethod, like every other patch site here: reading a method to hold and restore it
  // is the one thing `unbound-method` exists to flag, and the intention is named there once.
  const original = captureMethod(proto, 'attachShadow') as AttachShadow | undefined;
  if (typeof original !== 'function') return () => undefined;

  installs += 1;
  const patched: AttachShadow = function patchedAttachShadow(init) {
    const root = original.call(this, init);
    record(root, this);
    return root;
  };
  proto.attachShadow = patched;

  const sweep = (node: ParentNode): void => {
    for (const el of node.querySelectorAll('*')) {
      const root = el.shadowRoot;
      if (null === root) continue;
      record(root, el); // idempotent — a root the patch already caught is skipped inside

      sweep(root);
    }
  };
  if (document.documentElement !== null) sweep(document.documentElement);

  return () => {
    // Restore only if nobody patched over us; clobbering a later patch is worse than leaving ours.
    if (captureMethod(proto, 'attachShadow') === patched) proto.attachShadow = original;
    installs -= 1;
    if (installs > 0) return; // another install is still using this state
    roots.clear();
    listeners.clear();
  };
}
