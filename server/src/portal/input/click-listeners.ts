import type { Page } from 'playwright';

/**
 * A click handler reading that a page CANNOT produce for itself.
 *
 * `true` a real listener was found, `false` every node in the composed chain was read and none had
 * one, `undefined` the element could not be resolved or the chain could not be read, so nothing
 * could answer. Only the definite `false` may narrow the destructive-action guard; `undefined` keeps
 * the block.
 */
export type ClickListenerReading = boolean | undefined;

/**
 * How long the whole CDP read may take before it is abandoned.
 *
 * A guard runs on the way to a gesture, so a session that stops answering must not stall the act. The
 * measured cost of a full walk is single-digit milliseconds; this is far above that and exists only
 * to bound the pathological case. Abandoning the read answers `undefined`, which keeps the block.
 */
const READ_DEADLINE_MS = 2_000;

/** `promise`, or `undefined` if it has not settled within `ms`. */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The slice of a CDP session this needs, so a test can supply a fake without pulling in the full
 * playwright session type.
 */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
}

/**
 * The events a click on the element can run.
 *
 * `dblclick` is here because the guard gates `ActionType.DBLCLICK` too, and a link wired only for a
 * double click destroys just as much as one wired for a single click. The pointer and touch events
 * are here because a native gesture dispatches them and a handler on any of them runs. The set errs
 * wide on purpose: an event a page handles that is NOT here would be invisible to the guard.
 */
const CLICKISH_EVENTS: ReadonlySet<string> = new Set([
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'mousedown',
  'mouseup',
  'pointerdown',
  'pointerup',
  'touchstart',
  'touchend',
]);

/**
 * Every node whose listener a click on this element would run, in the COMPOSED tree.
 *
 * `parentElement` is null at a shadow root, so a plain ancestor walk stops inside a shadow tree and
 * never reaches the host or anything above it, which is exactly where a delegated handler sits. A
 * click is composed and crosses the shadow boundary, so this steps to `host` at a shadow root and
 * keeps going, then to `document` and `window`.
 *
 * The SHADOW ROOT ITSELF is pushed before its host: a listener on the root is on the propagation path
 * of a click from any of its descendants, and a delegated handler is commonly attached there rather
 * than to the host.
 *
 * A shadow root is detected by `nodeType === 11`, NOT by `node.host`. Every `<a href>` has a `host`
 * property too (the URL's hostname), so a truthiness test for it walks an anchor's HREF into the
 * chain and stops there, which is how a link wired with a real listener read as handlerless.
 *
 * Built in-page because only the page knows its own ancestry, and it returns the NODES rather than a
 * boolean so the listener query happens over CDP, where real listeners are visible.
 */
const CHAIN_FN = `function () {
  const chain = [];
  let node = this;
  while (node) {
    chain.push(node);
    if (11 === node.nodeType) {
      // A ShadowRoot: it is on the click path of its descendants and can carry the handler itself.
      node = node.host;
      continue;
    }
    node = node.parentElement || node.parentNode || null;
  }
  chain.push(document, window);
  return chain;
}`;

/**
 * The objectId of the element a `ref` names, as the SDK itself resolves it.
 *
 * Resolved through the page's own registry rather than by hit-testing a coordinate, so the node read
 * is provably the node the guard will act on: a box centre can land on an overlay, or on a different
 * element after a layout change between the inspect and the act. A detached ref is `undefined`.
 */
async function elementObjectId(session: CdpSession, ref: string): Promise<string | undefined> {
  const { result, exceptionDetails } = (await session.send('Runtime.evaluate', {
    expression: `(() => {
      const registry = globalThis.__reticleRefs;
      if (!registry || typeof registry.resolve !== 'function') return null;
      return registry.resolve(${JSON.stringify(ref)});
    })()`,
    returnByValue: false,
  })) as { result: { subtype?: string; objectId?: string }; exceptionDetails?: unknown };
  if (exceptionDetails !== undefined) return undefined;
  return 'null' === result.subtype ? undefined : result.objectId;
}

/** The objectIds of the composed chain, or [] when the page gave back nothing usable. */
async function chainObjectIds(session: CdpSession, objectId: string): Promise<string[]> {
  const { result, exceptionDetails } = (await session.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: CHAIN_FN,
    returnByValue: false,
  })) as { result: { objectId?: string }; exceptionDetails?: unknown };
  if (exceptionDetails !== undefined || result.objectId === undefined) return [];
  const { result: entries } = (await session.send('Runtime.getProperties', {
    objectId: result.objectId,
  })) as { result: { name: string; value?: { objectId?: string } }[] };
  return entries
    .filter((entry) => /^\d+$/.test(entry.name) && entry.value?.objectId !== undefined)
    .map((entry) => entry.value?.objectId ?? '')
    .filter((id) => id.length > 0);
}

/**
 * Whether the element a `ref` names, or any node whose listener a click on it would run, has a
 * click-ish listener, read through CDP's `DOMDebugger.getEventListeners`.
 *
 * `getEventListeners` reports REAL listeners, including ones bound with `addEventListener` that no
 * framework prop and no DOM attribute exposes. It does not walk ancestors and it does not walk the
 * composed tree, so both are done here explicitly.
 *
 * `DOMDebugger` is a Chromium-only domain, marked experimental in the protocol, so this answers only
 * where a CDP session exists and `undefined` everywhere else. That asymmetry is the point: an absence
 * is reported only where it was actually observed.
 */
export async function clickListenersForRef(
  session: CdpSession,
  ref: string,
): Promise<ClickListenerReading> {
  const objectId = await elementObjectId(session, ref);
  if (objectId === undefined) return undefined;
  const ids = await chainObjectIds(session, objectId);
  if (0 === ids.length) return undefined;
  for (const id of ids) {
    const { listeners } = (await session.send('DOMDebugger.getEventListeners', {
      objectId: id,
    })) as { listeners: { type: string }[] };
    if (listeners.some((listener) => CLICKISH_EVENTS.has(listener.type))) return true;
  }
  return false;
}

/**
 * The reading for the element a `ref` names on `page`, or `undefined` when no CDP session can be
 * opened or the element cannot be resolved.
 *
 * Read by ref, not by point, so a fact about the element is a fact about the control the guard will
 * act on. An unresolvable ref keeps the block.
 *
 * The deadline covers the WHOLE session lifecycle, opening and detaching included: a session that
 * stalls while opening, or a `detach` that never resolves, would otherwise hold the gesture open past
 * the bound. A read abandoned at the deadline answers `undefined`, which keeps the block.
 */
export async function clickListenersOnRef(page: Page, ref: string): Promise<ClickListenerReading> {
  try {
    return await withDeadline(readWithSession(page, ref), READ_DEADLINE_MS);
  } catch {
    // A detached session, a node that went away mid-read, a browser that does not implement the
    // domain, or a lifecycle that ran past its deadline. All of them mean "nothing could answer",
    // which is `undefined`, never `false`.
    return undefined;
  }
}

/** Open a session, read, and detach. Detach is attempted even when the read throws. */
async function readWithSession(page: Page, ref: string): Promise<ClickListenerReading> {
  const session = (await page.context().newCDPSession(page)) as unknown as CdpSession;
  try {
    return await clickListenersForRef(session, ref);
  } finally {
    await session.detach().catch(() => undefined);
  }
}
