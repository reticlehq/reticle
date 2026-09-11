import { EventType, TruncationChannel } from '@reticlehq/core';
import { getAccessibleName, getRole, isVisible } from '../dom/a11y.js';
import { refs } from '../dom/refs.js';

/**
 * A STABLE identity for the region a mutation happened in. Ambient learning cannot key on the element
 * ref for a churning list: every appended row is a NEW element (fresh ref) and a removed one has no ref
 * at all, so per-ref counts never accumulate and the region is never recognized as ambient. The
 * container persists across ticks, so its testid (or ref) is the identity that does accumulate.
 */
function regionKeyOf(target: Node): string | undefined {
  const el = isElement(target) ? target : null;
  if (null === el) return undefined;
  const labelled = el.closest('[data-testid]');
  return labelled?.getAttribute('data-testid') ?? refs.refFor(el);
}
import { isReticleOverlay } from '../dom/dom-ignore.js';
import type { Emit, Teardown } from './types.js';
import { capturedRoots, installShadowRegistry, onShadowRoot } from '../dom/shadow-registry.js';
import { isElement } from '../dom/realm.js';
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
  if (null === value) return undefined;
  return value.length > MAX_ATTR_VALUE_LEN ? `${value.slice(0, MAX_ATTR_VALUE_LEN)}…` : value;
}

const DIALOG_ROLES = new Set(['dialog', 'alertdialog']);
const LIVE_ROLES = new Set(['alert', 'status']);

/** Max meaningful added/removed nodes reported per mutation batch (backpressure). */
const MAX_PER_BATCH = 40;

function isMeaningful(role: string, name: string): boolean {
  return role !== 'generic' || name.length > 0;
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
    if (node.nodeType !== TEXT_NODE) continue;
    out += node.nodeValue ?? '';
  }
  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function installDom(emit: Emit): Teardown {
  // Installed here rather than in the bootstrap list because this observer is the registry's reason
  // for existing, and the ordering matters: a root attached between the two would be missed by both.
  // It is also the only chance to capture a CLOSED root, which attachShadow returns exactly once.
  const stopRegistry = installShadowRegistry();
  const observer = new MutationObserver((records) => {
    let added = 0;
    let removed = 0;
    let changed = 0;
    // Count element nodes dropped purely because a per-batch cap was already reached. The cap is on
    // MEANINGFUL events, so it is only hit after a real flood — the count is a raw over-estimate
    // (it can include not-yet-inspected noise) but `dropped > 0` honestly means "this batch was capped".
    let dropped = 0;
    for (const record of records) {
      if ('attributes' === record.type) {
        const target = record.target;
        if (isElement(target) && record.attributeName !== null && !isReticleOverlay(target)) {
          if (changed >= MAX_PER_BATCH) {
            dropped += 1;
            continue;
          }
          changed += 1;
          // Old value (attributeOldValue) + capped new value — a diff, not just a reading.
          const value = capValue(target.getAttribute(record.attributeName));
          const old = capValue(record.oldValue);
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
        if (parent !== null && !isReticleOverlay(parent)) {
          if (changed >= MAX_PER_BATCH) {
            dropped += 1;
            continue;
          }
          changed += 1;
          const text = (record.target.textContent ?? '').trim().slice(0, 80);
          const old = capValue(record.oldValue?.trim() ?? null);
          emit(
            EventType.DOM_TEXT,
            { text, ...(old === undefined ? {} : { old }) },
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
        if (parent !== null && !isReticleOverlay(parent)) {
          if (changed >= MAX_PER_BATCH) dropped += 1;
          else {
            changed += 1;
            // The element's text AFTER the mutation, so a cleared node reports '' rather than the
            // text that just left — the reader wants what is on screen now.
            const text = (parent.textContent ?? '').trim().slice(0, 80);
            const old = capValue(textOf(record.removedNodes) ?? null);
            emit(
              EventType.DOM_TEXT,
              { text, ...(old === undefined ? {} : { old }) },
              refs.refFor(parent),
            );
          }
        }
      }
      for (const node of record.addedNodes) {
        if (!isElement(node)) continue;
        if (added >= MAX_PER_BATCH) {
          dropped += 1;
          continue;
        }
        if (isReticleOverlay(node)) continue;
        const role = getRole(node);
        const name = getAccessibleName(node);
        if (!isMeaningful(role, name)) continue;
        added += 1;
        const ref = refs.refFor(node);
        emit(EventType.DOM_ADDED, { role, name, region: regionKeyOf(record.target) }, ref);
        if (
          DIALOG_ROLES.has(role) ||
          LIVE_ROLES.has(role) ||
          'true' === node.getAttribute('aria-modal')
        ) {
          if (isVisible(node)) emit(EventType.VISIBLE_SHOWN, { role, name }, ref);
        }
      }
      for (const node of record.removedNodes) {
        if (!isElement(node)) continue;
        if (removed >= MAX_PER_BATCH) {
          dropped += 1;
          continue;
        }
        if (isReticleOverlay(node)) continue;
        const role = getRole(node);
        const name = getAccessibleName(node);
        if (!isMeaningful(role, name)) continue;
        removed += 1;
        // A removed node has no ref (it is gone), so the CONTAINER is the only stable identity — and it
        // is what ambient learning needs to recognize a churning region.
        emit(EventType.DOM_REMOVED, { role, name, region: regionKeyOf(record.target) });
      }
    }
    // Never silent: a capped batch tells the ledger its DOM counts understate reality.
    if (dropped > 0) emit(EventType.TRUNCATED, { channel: TruncationChannel.DOM, dropped });
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
  for (const root of capturedRoots()) observer.observe(root, options);
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
