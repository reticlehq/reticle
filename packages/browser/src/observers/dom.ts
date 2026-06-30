import { EventType } from '@reticle/protocol';
import { getAccessibleName, getRole, isVisible } from '../dom/a11y.js';
import { refs } from '../dom/refs.js';
import { isReticleOverlay } from '../dom/dom-ignore.js';
import type { Emit, Teardown } from './types.js';

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
];

const DIALOG_ROLES = new Set(['dialog', 'alertdialog']);
const LIVE_ROLES = new Set(['alert', 'status']);

/** Max meaningful added/removed nodes reported per mutation batch (backpressure). */
const MAX_PER_BATCH = 40;

function isMeaningful(role: string, name: string): boolean {
  return role !== 'generic' || name.length > 0;
}

/** Observe DOM mutations and emit semantic (not raw) events. See plan/03 §1. */
export function installDom(emit: Emit): Teardown {
  const observer = new MutationObserver((records) => {
    let added = 0;
    let removed = 0;
    let changed = 0;
    for (const record of records) {
      if (record.type === 'attributes') {
        const target = record.target;
        if (
          target instanceof Element &&
          record.attributeName !== null &&
          changed < MAX_PER_BATCH &&
          !isReticleOverlay(target)
        ) {
          changed += 1;
          emit(
            EventType.DOM_ATTR,
            { attr: record.attributeName, value: target.getAttribute(record.attributeName) },
            refs.refFor(target),
          );
        }
        continue;
      }
      if (record.type === 'characterData') {
        // In-place text change inside an existing subtree (wizard steps, inline edits) —
        // childList-only would miss this.
        const parent = record.target.parentElement;
        if (parent !== null && changed < MAX_PER_BATCH && !isReticleOverlay(parent)) {
          changed += 1;
          const text = (record.target.textContent ?? '').trim().slice(0, 80);
          emit(EventType.DOM_TEXT, { text }, refs.refFor(parent));
        }
        continue;
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element) || added >= MAX_PER_BATCH) continue;
        if (isReticleOverlay(node)) continue;
        const role = getRole(node);
        const name = getAccessibleName(node);
        if (!isMeaningful(role, name)) continue;
        added += 1;
        const ref = refs.refFor(node);
        emit(EventType.DOM_ADDED, { role, name }, ref);
        if (
          DIALOG_ROLES.has(role) ||
          LIVE_ROLES.has(role) ||
          node.getAttribute('aria-modal') === 'true'
        ) {
          if (isVisible(node)) emit(EventType.VISIBLE_SHOWN, { role, name }, ref);
        }
      }
      for (const node of record.removedNodes) {
        if (!(node instanceof Element) || removed >= MAX_PER_BATCH) continue;
        if (isReticleOverlay(node)) continue;
        const role = getRole(node);
        const name = getAccessibleName(node);
        if (!isMeaningful(role, name)) continue;
        removed += 1;
        emit(EventType.DOM_REMOVED, { role, name });
      }
    }
  });

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: WATCHED_ATTRS,
    characterData: true,
  });

  return () => {
    observer.disconnect();
  };
}
