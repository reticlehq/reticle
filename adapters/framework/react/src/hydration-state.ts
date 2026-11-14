/**
 * Has React hydrated every server-rendered part of the page? Read from React's own fibers (#1654).
 *
 * The first commit is not the answer. Next commits the shell, and a Suspense boundary under it can
 * hydrate seconds later. Until then the boundary's server-rendered button has no handler, so a click
 * on it does nothing. React keeps such a boundary in the tree as a "dehydrated" fiber, so a walk of
 * the committed tree can say which part still waits.
 *
 * HOST-SAFE: an unknown fiber shape gives DONE, which is what the adapter said before this existed.
 */
import { MAX_FIBER_NODES, findFiber, topOf, type FiberNode } from './auto-stores.js';

export const HydrationState = {
  /** React has not put a fiber on the page yet. */
  NONE: 'none',
  /** React rendered, and a server-rendered part still has no event handlers. */
  PENDING: 'pending',
  /** React rendered, and nothing waits for hydration. */
  DONE: 'done',
} as const;
export type HydrationState = (typeof HydrationState)[keyof typeof HydrationState];

/** React's fiber tags that can hold a dehydrated part (react-reconciler `ReactWorkTags`). */
const FiberTag = {
  SUSPENSE: 13,
  DEHYDRATED_FRAGMENT: 18,
  ACTIVITY: 31,
} as const;

interface StatefulFiber extends FiberNode {
  tag?: unknown;
  stateNode?: unknown;
  memoizedState?: unknown;
}

function fieldOf(value: unknown, key: string): unknown {
  return null !== value && 'object' === typeof value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** The committed root fiber. A fiber found on the page can belong to the tree in progress. */
function committedRoot(top: StatefulFiber): StatefulFiber {
  const current = fieldOf(top.stateNode, 'current');
  return null !== current && 'object' === typeof current ? current : top;
}

function isDehydrated(fiber: StatefulFiber): boolean {
  if (FiberTag.DEHYDRATED_FRAGMENT === fiber.tag) {
    return true;
  }
  if (FiberTag.SUSPENSE !== fiber.tag && FiberTag.ACTIVITY !== fiber.tag) {
    return false;
  }
  const dehydrated = fieldOf(fiber.memoizedState, 'dehydrated');
  return null !== dehydrated && undefined !== dehydrated;
}

function anyDehydrated(root: StatefulFiber): boolean {
  const stack: StatefulFiber[] = [root];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_FIBER_NODES) {
    const fiber = stack.pop();
    if (undefined === fiber) {
      continue;
    }
    visited += 1;
    if (isDehydrated(fiber)) {
      return true;
    }
    const { sibling, child } = fiber;
    if (null !== sibling && undefined !== sibling) {
      stack.push(sibling);
    }
    if (null !== child && undefined !== child) {
      stack.push(child);
    }
  }
  return false;
}

/** React marks the node it renders into (for Next, the document) with its root fiber. */
const CONTAINER_PREFIX = '__reactContainer$';
/** How many elements to look at for a root container. A root is near the top. */
const MAX_CONTAINER_SCAN = 200;

function containerFiber(node: unknown): FiberNode | null {
  if (null === node || 'object' !== typeof node) {
    return null;
  }
  for (const key of Object.keys(node)) {
    const fiber = (node as Record<string, unknown>)[key];
    if (key.startsWith(CONTAINER_PREFIX) && null !== fiber && 'object' === typeof fiber) {
      return fiber;
    }
  }
  return null;
}

/**
 * A fiber of the React tree on `doc`. The root container comes first: when every element on the page
 * is in a dehydrated boundary, no element carries a fiber, and the page still waits for hydration.
 */
function entryFiber(doc: Document): FiberNode | null {
  const elements = doc.querySelectorAll('*');
  const nodes: unknown[] = [doc];
  for (let i = 0; i < Math.min(elements.length, MAX_CONTAINER_SCAN); i += 1) {
    nodes.push(elements[i]);
  }
  for (const node of nodes) {
    const fiber = containerFiber(node);
    if (null !== fiber) {
      return fiber;
    }
  }
  return findFiber(doc);
}

/** The hydration state of the React tree on `doc`. */
export function readHydrationState(doc: Document): HydrationState {
  try {
    const entry = entryFiber(doc);
    if (null === entry) {
      return HydrationState.NONE;
    }
    const root = committedRoot(topOf(entry));
    // A root that `hydrateRoot` created stays dehydrated until its first commit.
    if (true === fieldOf(root.memoizedState, 'isDehydrated')) {
      return HydrationState.PENDING;
    }
    return anyDehydrated(root) ? HydrationState.PENDING : HydrationState.DONE;
  } catch {
    return HydrationState.DONE;
  }
}
