/**
 * Reading the snapshot tree — the one line-per-element text format the browser emits.
 *
 * It lives in core because it is a WIRE format: the browser writes it, and several things on the
 * Node side read it back. It was previously a helper beside the MCP tool handlers, which made every
 * other reader import from the tool surface to parse a string the tool surface does not own — and a
 * directory guard caught exactly that the moment a second layer needed it.
 *
 * A line looks like:
 *
 *   - button "Pay $42.00" (ref=e4) [disabled]
 *
 * Only elements carrying a `ref` can be acted on, so only those are returned.
 */

/** One interactive element: its ref, and the line it came from with the ref taken out. */
export interface InteractiveItem {
  ref: string;
  desc: string;
}

const REF = /\(ref=(e\d+)\)/;
const REF_GLOBAL = /\s*\(ref=e\d+\)/;

/** Parse interactive elements (those with refs) out of a snapshot tree. */
export function parseInteractive(tree: string): InteractiveItem[] {
  const items: InteractiveItem[] = [];
  for (const line of tree.split('\n')) {
    const match = REF.exec(line);
    if (match !== null) {
      items.push({ ref: match[1] ?? '', desc: line.replace(REF_GLOBAL, '').trim() });
    }
  }
  return items;
}
