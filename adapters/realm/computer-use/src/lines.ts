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

  refFor(key: string): string {
    const known = this.refOfKey.get(key);
    if (known !== undefined) {
      return known;
    }
    const ref = `e${String(this.refOfKey.size + 1)}`;
    this.refOfKey.set(key, ref);
    this.keyOfRef.set(ref, key);
    return ref;
  }

  /** The key a ref was given for, to find the element again in a new read. */
  keyOf(ref: string): string | undefined {
    return this.keyOfRef.get(ref);
  }
}

export interface Written {
  tree: string;
  /** Elements left out because they have no place on the screen: closed menus, for the most part. */
  omitted: number;
}

/** The tree of what is on the screen. See `placeShown`. */
export function writeWindows(root: UiNode, refs: RefTable): Written {
  const { shown, omitted } = placeShown(root);
  return { tree: writePlaced(shown, refs), omitted };
}

export function writeLines(root: UiNode, refs: RefTable): string {
  return writePlaced(place(root), refs);
}

function writePlaced(placed: readonly Placed[], refs: RefTable): string {
  return placed
    .map(({ node, depth, key }) => {
      const ref = isAddressable(node) ? ` (ref=${refs.refFor(key)})` : '';
      const value =
        node.value !== undefined && node.value.length > 0 ? ` [value=${quoted(node.value)}]` : '';
      // A loss is said on the line that has it: scroll to read the rows that are not here.
      const left = node.notShown === undefined ? '' : ` [not shown: ${String(node.notShown)}]`;
      const states = node.states.length > 0 ? ` [${node.states.join(',')}]` : '';
      return `${INDENT.repeat(depth)}- ${label(node)}${ref}${value}${left}${states}`;
    })
    .join('\n');
}
