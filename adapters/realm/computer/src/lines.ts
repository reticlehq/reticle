/**
 * Writes a tree as the one-line-per-element text that `core`'s `parseInteractive` and the Harness
 * read. The browser realm writes the same format from the DOM.
 *
 * ponytail: the format has two writers now. Move one pure writer into `core` when the browser
 * adopts it.
 */
import { isAddressable, label, place, placeShown, quoted } from './ui-node.js';
import type { Placed, UiNode } from './ui-node.js';

const INDENT = '  ';

/**
 * Gives each element one ref for the life of a session. An element that goes away keeps its ref,
 * so a ref from an old read never points at a different element.
 */
export class RefTable {
  private readonly refOfKey = new Map<string, string>();
  private readonly keyOfRef = new Map<string, string>();
  /** Refs given so far. Not the size of a map: a ref that moved leaves no key behind. */
  private given = 0;

  /** What each ref named when it was given: to know the element again at another key. */
  private readonly whoOfRef = new Map<string, UiNode>();

  refFor(key: string, node?: UiNode): string {
    const known = this.refOfKey.get(key);
    const ref = known ?? `e${String(this.given + 1)}`;
    if (known === undefined) {
      this.given += 1;
      this.refOfKey.set(key, ref);
      this.keyOfRef.set(ref, key);
    }
    if (node !== undefined) {
      this.whoOfRef.set(ref, node);
    }
    return ref;
  }

  /** The element a ref named when it was given or last seen. Absent: not known. */
  whoOf(ref: string): UiNode | undefined {
    return this.whoOfRef.get(ref);
  }

  /**
   * The element of a ref is at another key now: the application changed the tree round it. The
   * ref goes with the element. The old key is forgotten, so that another element that comes to
   * that place gets a ref of its own.
   */
  move(ref: string, key: string): void {
    const old = this.keyOfRef.get(ref);
    if (old !== undefined) {
      this.refOfKey.delete(old);
    }
    this.refOfKey.set(key, ref);
    this.keyOfRef.set(ref, key);
  }

  /** The key a ref was given for, to find the element again in a new read. */
  keyOf(ref: string): string | undefined {
    return this.keyOfRef.get(ref);
  }
}

/** Said on the line of an element whose name the realm took from the thing beside it. */
export const NAME_FROM_NEIGHBOUR = 'name from neighbour';

export interface Written {
  tree: string;
  /** Elements left out because they have no place on the screen: closed menus, for the most part. */
  omitted: number;
}

/** The tree of what is on the screen. See `placeShown`. */
export function writeWindows(root: UiNode, refs: RefTable): Written {
  const { shown, omitted, outOfView } = placeShown(root);
  return { tree: writePlaced(shown, refs, outOfView), omitted };
}

export function writeLines(root: UiNode, refs: RefTable): string {
  return writePlaced(place(root), refs);
}

function writePlaced(
  placed: readonly Placed[],
  refs: RefTable,
  outOfView: ReadonlyMap<string, number> = new Map(),
): string {
  return placed
    .map(({ node, depth, key }) => {
      const ref = isAddressable(node) ? ` (ref=${refs.refFor(key, node)})` : '';
      const value =
        node.value !== undefined && node.value.length > 0 ? ` [value=${quoted(node.value)}]` : '';
      // A loss is said on the line that has it: scroll to read the rows that are not here.
      // A list of a page with items scrolled out of the window says so too.
      const notShown = node.notShown ?? outOfView.get(key);
      const left = notShown === undefined ? '' : ` [not shown: ${String(notShown)}]`;
      const states = node.states.length > 0 ? ` [${node.states.join(',')}]` : '';
      const guessed = true === node.nameGuessed ? ` [${NAME_FROM_NEIGHBOUR}]` : '';
      return `${INDENT.repeat(depth)}- ${label(node)}${ref}${guessed}${value}${left}${states}`;
    })
    .join('\n');
}
