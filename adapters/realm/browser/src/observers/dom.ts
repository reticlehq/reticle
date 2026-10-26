import { readTestId, testIdSelector } from '@/dom/addressing/testid-attr.js';
import { EventType, REDACTED_VALUE, TruncationChannel } from '@reticlehq/core';
import { getAccessibleName, getRole, isSensitiveField } from '@/dom/a11y.js';
import { isVisible } from '@/dom/visibility.js';
import { refs } from '@/dom/addressing/refs.js';

/**
 * A STABLE identity for the region a mutation happened in. Ambient learning cannot key on the element
 * ref for a churning list: every appended row is a NEW element (fresh ref) and a removed one has no ref
 * at all, so per-ref counts never accumulate and the region is never recognized as ambient. The
 * container persists across ticks, so its testid (or ref) is the identity that does accumulate.
 */
function regionKeyOf(target: Node): string | undefined {
  const el = isElement(target) ? target : null;
  if (null === el) {
    return undefined;
  }
  const labelled = el.closest(testIdSelector());
  return (labelled ? readTestId(labelled) : null) ?? refs.refFor(el);
}
import { isUnobserved } from '@/dom/dom-ignore.js';
import type { Emit, Teardown } from './types.js';
import { capturedRoots, installShadowRegistry, onShadowRoot } from '@/dom/shadow-registry.js';
import { isElement } from '@/dom/realm.js';
import { observeSameOriginFrames } from './frames.js';

const WATCHED_ATTRS = [
  'class',
  'hidden',
  'disabled',
  'open',
  'aria-hidden',
  'aria-expanded',
  'aria-selected',
  'aria-checked',
  'data-state',
  // Widened: visual + resource + form-value attributes. Values are capped (they can be long).
  'style',
  'src',
  'href',
  'value',
];

/** Attribute/text values are capped per event — style/src can be huge and would bloat the ledger. */
const MAX_ATTR_VALUE_LEN = 120;

function capValue(value: string | null): string | undefined {
  if (null === value) {
    return undefined;
  }
  return value.length > MAX_ATTR_VALUE_LEN ? `${value.slice(0, MAX_ATTR_VALUE_LEN)}…` : value;
}

const DIALOG_ROLES = new Set(['dialog', 'alertdialog']);
const LIVE_ROLES = new Set(['alert', 'status']);

/** Max meaningful added/removed nodes reported per mutation batch (backpressure). */
const MAX_PER_BATCH = 40;

function isMeaningful(role: string, name: string): boolean {
  return role !== 'generic' || name.length > 0;
}

/** How far into an added wrapper to look for the thing that arrived in it. */
const MOUNT_SCAN_LIMIT = 40;

/**
 * What actually arrived, when the node that arrived is a bare wrapper.
 *
 * A mount is ONE childList record carrying the outermost node, and everything the feature is made of
 * comes along INSIDE it rather than as records of its own. So filtering the wrapper on its own role
 * drops the whole subtree with it — and a `<div class="palette-scrim">` around a command palette is
 * exactly that shape.
 *
 * Measured on bench-app: opening the palette committed `paletteOpen: false -> true`, fired the app's
 * own `palette:opened`, ran its animations and emitted NOT ONE DOM event, while a raw
 * `MutationObserver` with this observer's own config saw the mutation. Every absence-derived rule
 * reads this stream, so `crawl` reported `state-vs-render` — "the store committed, nothing rendered"
 * — against an app that had rendered correctly.
 *
 * Bounded, and the bound is the point: this runs inside the app's mutation callback, so an unbounded
 * walk of a freshly mounted page would be paid on every render. Past the limit the wrapper is treated
 * as it always was — the filter keeps working for layout noise, which is what it is for.
 */
function describeMount(node: Element): { role: string; name: string; el: Element } | undefined {
  const role = getRole(node);
  const name = getAccessibleName(node);
  if (isMeaningful(role, name)) {
    return { role, name, el: node };
  }
  let scanned = 0;
  for (const child of node.querySelectorAll('*')) {
    if (scanned >= MOUNT_SCAN_LIMIT) {
      return undefined;
    }
    scanned += 1;
    if (isUnobserved(child)) {
      continue;
    }
    const childRole = getRole(child);
    const childName = getAccessibleName(child);
    if (isMeaningful(childRole, childName)) {
      return { role: childRole, name: childName, el: child };
    }
  }
  return undefined;
}

/** Observe DOM mutations and emit semantic (not raw) events. */
/**
 * The trimmed text carried by a node list, or undefined when it carries none.
 *
 * Whitespace-only nodes are ignored deliberately: a re-render that reshuffles indentation would
 * otherwise emit a text change on every layout node, which is noise the timeline cannot afford.
 */
const TEXT_NODE = 3;

function textOf(nodes: NodeList): string | undefined {
  let out = '';
  for (const node of nodes) {
    // The numeric nodeType, not `Node.TEXT_NODE`: the global `Node` constructor is not guaranteed to
    // exist wherever this runs, and referencing it threw a ReferenceError rather than degrading.
    if (node.nodeType !== TEXT_NODE) {
      continue;
    }
    out += node.nodeValue ?? '';
  }
  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Attributes that say how a field LOOKS or behaves, never what was typed into it. */
const SAFE_ON_SECRET = new Set([
  'class',
  'style',
  'type',
  'disabled',
  'readonly',
  'required',
  'hidden',
]);

/** Whether this attribute of this element could carry a typed secret: any but the safe few, on a secret field. */
function secretAttr(el: Element, attr: string): boolean {
  return !SAFE_ON_SECRET.has(attr) && !attr.startsWith('aria-') && isSensitiveField(el);
}

/** How far up a text change looks for the testid that names it. */
const TESTID_DEPTH = 3;
/** Testid elements whose arrival text one batch reports; past this they are counted as dropped. */
const MAX_INITIAL_TEXTS = 50;

/** The `data-testid` of `el` or its nearest ancestor within TESTID_DEPTH, so a change has a name. */
function testidNear(el: Element): string | undefined {
  let at: Element | null = el;
  for (let depth = 0; at !== null && depth <= TESTID_DEPTH; depth += 1) {
    const id = readTestId(at);
    if (id !== null && id.length > 0) {
      return id;
    }
    at = at.parentElement;
  }
  return undefined;
}

/** `{ testid }` when there is one, else nothing: the field is absent, never empty. */
const named = (el: Element): { testid?: string } => {
  const testid = testidNear(el);
  return testid === undefined ? {} : { testid };
};

export function installDom(emit: Emit): Teardown {
  // Installed here rather than in the bootstrap list because this observer is the registry's reason
  // for existing, and the ordering matters: a root attached between the two would be missed by both.
  // It is also the only chance to capture a CLOSED root, which attachShadow returns exactly once.
  const stopRegistry = installShadowRegistry();
  const observer = new MutationObserver((records) => {
    let added = 0;
    let removed = 0;
    let changed = 0;
    let initials = 0;
    // Count element nodes dropped purely because a per-batch cap was already reached. The cap is on
    // MEANINGFUL events, so it is only hit after a real flood — the count is a raw over-estimate
    // (it can include not-yet-inspected noise) but `dropped > 0` honestly means "this batch was capped".
    let dropped = 0;
    for (const record of records) {
      if ('attributes' === record.type) {
        const target = record.target;
        if (isElement(target) && record.attributeName !== null && !isUnobserved(target)) {
          if (changed >= MAX_PER_BATCH) {
            dropped += 1;
            continue;
          }
          changed += 1;
          // Old value (attributeOldValue) + capped new value — a diff, not just a reading. Never a
          // secret field's: a password input's `value` attribute reached the session journal in clear.
          const hide = secretAttr(target, record.attributeName);
          const value = hide ? REDACTED_VALUE : capValue(target.getAttribute(record.attributeName));
          const old = hide && null !== record.oldValue ? REDACTED_VALUE : capValue(record.oldValue);
          emit(
            EventType.DOM_ATTR,
            {
              attr: record.attributeName,
              ...(value === undefined ? {} : { value }),
              ...(old === undefined ? {} : { old }),
            },
            refs.refFor(target),
          );
        }
        continue;
      }
      if ('characterData' === record.type) {
        // In-place text change inside an existing subtree (wizard steps, inline edits) —
        // childList-only would miss this.
        const parent = record.target.parentElement;
        if (parent !== null && !isUnobserved(parent)) {
          if (changed >= MAX_PER_BATCH) {
            dropped += 1;
            continue;
          }
          changed += 1;
          // A secret `<textarea>`'s content is its text node: the same rule as its value.
          const hide = isSensitiveField(parent);
          const text = hide
            ? REDACTED_VALUE
            : (record.target.textContent ?? '').trim().slice(0, 80);
          const old = hide ? undefined : capValue(record.oldValue?.trim() ?? null);
          emit(
            EventType.DOM_TEXT,
            { text, ...(old === undefined ? {} : { old }), ...named(parent) },
            refs.refFor(parent),
          );
        }
        continue;
      }
      // A TEXT node arriving or leaving is a text change, and it is the ordinary one. `characterData`
      // fires only when an EXISTING text node's `data` is edited in place; `el.textContent = x`,
      // `innerText`, and React replacing a child all REPLACE the node instead — a childList mutation
      // carrying a Text node, which the Element-only loops below skip. Measured on a live page:
      // `firstChild.data = x` emitted `dom.text`, while `textContent`, `innerText` and
      // `appendChild(createTextNode())` emitted NOTHING. So the most common visible change an app
      // makes — updating text — produced no event at all, `reticle_observe` reported "nothing
      // happened" over a screen that had visibly changed, and `settled` went quiet immediately.
      if (textOf(record.addedNodes) !== undefined || textOf(record.removedNodes) !== undefined) {
        const parent = isElement(record.target) ? record.target : null;
        if (parent !== null && !isUnobserved(parent)) {
          if (changed >= MAX_PER_BATCH) {
            dropped += 1;
          } else {
            changed += 1;
            // The element's text AFTER the mutation, so a cleared node reports '' rather than the
            // text that just left — the reader wants what is on screen now.
            const hide = isSensitiveField(parent);
            const text = hide ? REDACTED_VALUE : (parent.textContent ?? '').trim().slice(0, 80);
            const old = hide ? undefined : capValue(textOf(record.removedNodes) ?? null);
            emit(
              EventType.DOM_TEXT,
              { text, ...(old === undefined ? {} : { old }), ...named(parent) },
              refs.refFor(parent),
            );
          }
        }
      }
      for (const node of record.addedNodes) {
        if (!isElement(node)) {
          continue;
        }
        if (added >= MAX_PER_BATCH) {
          dropped += 1;
          continue;
        }
        if (isUnobserved(node)) {
          continue;
        }
        // The text each named element ARRIVED with: the baseline a later change, or the lack of
        // one, is read against. Without it "never changed" and "never shown" look the same.
        const testids = [node, ...Array.from(node.querySelectorAll(testIdSelector()))].filter(
          (el) => readTestId(el) !== null,
        );
        for (const el of testids) {
          const text = (el.textContent ?? '').trim();
          if (0 === text.length) {
            continue;
          }
          if (initials >= MAX_INITIAL_TEXTS) {
            dropped += 1;
            continue;
          }
          initials += 1;
          const shown = isSensitiveField(el) ? REDACTED_VALUE : text.slice(0, 80);
          emit(
            EventType.DOM_TEXT,
            { text: shown, testid: readTestId(el) ?? '', initial: true },
            refs.refFor(el),
          );
        }
        const mounted = describeMount(node);
        if (mounted === undefined) {
          continue;
        }
        const { role, name } = mounted;
        added += 1;
        // The ref points at what arrived, not at the wrapper it arrived in: a wrapper is not
        // something an agent can act on, and the whole value of this event is naming the thing.
        const ref = refs.refFor(mounted.el);
        emit(EventType.DOM_ADDED, { role, name, region: regionKeyOf(record.target) }, ref);
        if (
          DIALOG_ROLES.has(role) ||
          LIVE_ROLES.has(role) ||
          'true' === node.getAttribute('aria-modal')
        ) {
          if (isVisible(node)) {
            emit(EventType.VISIBLE_SHOWN, { role, name }, ref);
          }
        }
      }
      for (const node of record.removedNodes) {
        if (!isElement(node)) {
          continue;
        }
        if (removed >= MAX_PER_BATCH) {
          dropped += 1;
          continue;
        }
        // A removed node is DETACHED, so `closest()` cannot climb from it to the overlay it came out
        // of; ask the parent it was removed from, which is still in the document. Without this every
        // node Reticle's own HUD rebuilt read as the app's DOM changing - enough to hide a route that
        // rendered nothing, which then came back verified:"yes".
        if (isUnobserved(node) || (isElement(record.target) && isUnobserved(record.target))) {
          continue;
        }
        // Same reasoning as the mount above, in reverse: a dismissed modal leaves as ONE record
        // carrying its wrapper, so filtering on the wrapper's own role makes the dismissal silent.
        const gone = describeMount(node);
        if (gone === undefined) {
          continue;
        }
        const { role, name } = gone;
        removed += 1;
        // A removed node has no ref (it is gone), so the CONTAINER is the only stable identity — and it
        // is what ambient learning needs to recognize a churning region.
        emit(EventType.DOM_REMOVED, { role, name, region: regionKeyOf(record.target) });
      }
    }
    // Never silent: a capped batch tells the ledger its DOM counts understate reality.
    if (dropped > 0) {
      emit(EventType.TRUNCATED, { channel: TruncationChannel.DOM, dropped });
    }
  });

  const options: MutationObserverInit = {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: WATCHED_ATTRS,
    attributeOldValue: true,
    characterData: true,
    characterDataOldValue: true,
  };
  observer.observe(document.documentElement, options);

  // A MutationObserver does NOT cross a shadow boundary, so every root needs its own observation.
  // Without this, a click that changed text inside a web component produced an empty observe window —
  // the same shape as an app that ignored the click entirely.
  for (const root of capturedRoots()) {
    observer.observe(root, options);
  }
  const unsubscribe = onShadowRoot((root) => observer.observe(root, options));

  // Same-origin frame documents are separate node trees for the same reason, with the same symptom.
  const stopFrames = observeSameOriginFrames((body) => observer.observe(body, options));

  return () => {
    stopFrames();
    unsubscribe();
    stopRegistry();
    observer.disconnect();
  };
}
