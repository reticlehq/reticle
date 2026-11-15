/**
 * Has React hydrated every server-rendered part of the page? Read from React's own fibers (#1654).
 *
 * The first commit is not the answer. Next commits the shell, and a Suspense boundary under it can
 * hydrate seconds later. Until then the boundary's server-rendered button has no handler, so a click
 * on it does nothing. React keeps such a boundary in the tree as a "dehydrated" fiber, so a walk of
 * the committed tree can say which part still waits.
 *
 * A read that cannot be sure says UNKNOWN, never DONE. A wrong DONE sends replay into a page without
 * handlers, which is the defect this exists for.
 *
 * HOST-SAFE: nothing here throws into the app. A fiber shape this module does not know gives UNKNOWN.
 */
import { HydrationState } from '@reticlehq/core';
import { findFiber, topOf } from './auto-stores.js';

/** React's fiber tags that this module reads (react-reconciler `ReactWorkTags`). */
const FiberTag = {
  HOST_ROOT: 3,
  SUSPENSE: 13,
  DEHYDRATED_FRAGMENT: 18,
  ACTIVITY: 31,
} as const;

/** The fields of React's internals that this module reads. */
const FiberField = {
  /** `FiberRoot.current`: the HostRoot fiber of the committed tree. */
  CURRENT: 'current',
  /** `FiberRoot.containerInfo`: the node the root renders into. Only a FiberRoot has it. */
  CONTAINER_INFO: 'containerInfo',
  /** `Fiber.stateNode`: for a HostRoot fiber, its FiberRoot. */
  STATE_NODE: 'stateNode',
  /** `Fiber.memoizedState`: the committed state of a root or a boundary. */
  MEMOIZED_STATE: 'memoizedState',
  /** `SuspenseState.dehydrated` and `ActivityState.dehydrated`: server HTML not hydrated yet. */
  DEHYDRATED: 'dehydrated',
  /** `RootState.isDehydrated`: a `hydrateRoot` root before its first commit. */
  IS_DEHYDRATED: 'isDehydrated',
  TAG: 'tag',
  CHILD: 'child',
  SIBLING: 'sibling',
} as const;

/** React marks the node it renders into (for Next, the document) with its HostRoot fiber. */
const CONTAINER_PREFIX = '__reactContainer$';
/** How many elements to look at for a root container. A root is near the top of most pages. */
const MAX_CONTAINER_SCAN = 200;
/**
 * The most fibers one read visits, over all roots. A cap so that a strange fiber graph cannot hang
 * the app. It is ten times the store-discovery walk, because here a walk cut short cannot answer.
 */
export const MAX_HYDRATION_WALK = 200_000;

function fieldOf(value: unknown, key: string): unknown {
  return null !== value && 'object' === typeof value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function isObject(value: unknown): value is object {
  return null !== value && 'object' === typeof value;
}

/** The FiberRoot of a value: a FiberRoot itself, or any fiber of its tree. */
function fiberRootOf(value: unknown): object | null {
  if (!isObject(value)) {
    return null;
  }
  if (
    isObject(fieldOf(value, FiberField.CURRENT)) &&
    undefined !== fieldOf(value, FiberField.CONTAINER_INFO)
  ) {
    return value;
  }
  const top = topOf(value);
  if (FiberTag.HOST_ROOT !== fieldOf(top, FiberField.TAG)) {
    return null;
  }
  const root = fieldOf(top, FiberField.STATE_NODE);
  return isObject(root) && isObject(fieldOf(root, FiberField.CURRENT)) ? root : null;
}

function containerFiber(node: unknown): unknown {
  if (!isObject(node)) {
    return null;
  }
  for (const key of Object.keys(node)) {
    if (key.startsWith(CONTAINER_PREFIX)) {
      return (node as Record<string, unknown>)[key];
    }
  }
  return null;
}

/**
 * The React roots that `doc` shows: every root container among the document and its first elements.
 * When none is there, the root of the first element that carries a fiber.
 */
function rootsOnPage(doc: Document): object[] {
  const nodes: unknown[] = [doc];
  const elements = doc.querySelectorAll('*');
  for (let i = 0; i < Math.min(elements.length, MAX_CONTAINER_SCAN); i += 1) {
    nodes.push(elements[i]);
  }
  const roots: object[] = [];
  for (const node of nodes) {
    const root = fiberRootOf(containerFiber(node));
    if (null !== root) {
      roots.push(root);
    }
  }
  if (0 === roots.length) {
    const root = fiberRootOf(findFiber(doc));
    if (null !== root) {
      roots.push(root);
    }
  }
  return roots;
}

function isDehydrated(fiber: unknown): boolean {
  const tag = fieldOf(fiber, FiberField.TAG);
  if (FiberTag.DEHYDRATED_FRAGMENT === tag) {
    return true;
  }
  if (FiberTag.SUSPENSE !== tag && FiberTag.ACTIVITY !== tag) {
    return false;
  }
  const dehydrated = fieldOf(fieldOf(fiber, FiberField.MEMOIZED_STATE), FiberField.DEHYDRATED);
  return null !== dehydrated && undefined !== dehydrated;
}

/** What one walk found, and how many fibers it may still visit. */
interface Walk {
  state: HydrationState;
  left: number;
}

/** Walk the committed tree of one root, down to the first dehydrated part. */
function readRoot(root: object, budget: number): Walk {
  const current = fieldOf(root, FiberField.CURRENT);
  if (true === fieldOf(fieldOf(current, FiberField.MEMOIZED_STATE), FiberField.IS_DEHYDRATED)) {
    return { state: HydrationState.PENDING, left: budget };
  }
  const stack: unknown[] = [current];
  let left = budget;
  while (stack.length > 0) {
    if (0 === left) {
      return { state: HydrationState.UNKNOWN, left };
    }
    const fiber = stack.pop();
    left -= 1;
    if (isDehydrated(fiber)) {
      return { state: HydrationState.PENDING, left };
    }
    for (const next of [fieldOf(fiber, FiberField.SIBLING), fieldOf(fiber, FiberField.CHILD)]) {
      if (isObject(next)) {
        stack.push(next);
      }
    }
  }
  return { state: HydrationState.DONE, left };
}

/**
 * The hydration state of the React trees on `doc`.
 *
 * @param known FiberRoots the commit hook named. They count wherever their container is on the
 *   page, so a root the page scan does not reach is still read.
 */
export function readHydrationState(doc: Document, known: Iterable<unknown> = []): HydrationState {
  try {
    const roots = new Set<object>();
    for (const value of [...known, ...rootsOnPage(doc)]) {
      const root = fiberRootOf(value);
      if (null !== root) {
        roots.add(root);
      }
    }
    if (0 === roots.size) {
      return HydrationState.NONE;
    }
    let left = MAX_HYDRATION_WALK;
    let unsure = false;
    for (const root of roots) {
      const walk = readRoot(root, left);
      if (HydrationState.PENDING === walk.state) {
        return HydrationState.PENDING;
      }
      unsure = unsure || HydrationState.UNKNOWN === walk.state;
      left = walk.left;
    }
    return unsure ? HydrationState.UNKNOWN : HydrationState.DONE;
  } catch {
    // A fiber shape this module does not know. Say so; never claim DONE on it.
    return HydrationState.UNKNOWN;
  }
}
