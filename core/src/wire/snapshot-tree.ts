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

/**
 * Parse interactive elements (those with refs) out of a snapshot tree.
 *
 * The description used to be built with a SECOND regex, `/\s*\(ref=e\d+\)/`, whose leading `\s*`
 * made it quadratic: on a line with a long run of whitespace the engine retries the unbounded
 * prefix at every position before failing the literal that follows. The tree is page-derived, so
 * that run is app-controlled, and CodeQL flagged it as a polynomial ReDoS on the release branch.
 *
 * `REF` has already located the token, so the description is the line with that exact span cut
 * out. The `\s*` was NOT redundant -- it ate the gap left behind when a ref sits mid-line, and two
 * pinned tests failed when it was dropped outright -- so the prefix is trimmed instead. `trimEnd`
 * is a string method: same result, linear, and one fewer regex to keep in step with the first.
 */
export function parseInteractive(tree: string): InteractiveItem[] {
  const items: InteractiveItem[] = [];
  for (const line of tree.split('\n')) {
    const match = REF.exec(line);
    if (match !== null) {
      const token = match[0];
      const at = line.indexOf(token);
      items.push({
        ref: match[1] ?? '',
        desc: `${line.slice(0, at).trimEnd()}${line.slice(at + token.length)}`.trim(),
      });
    }
  }
  return items;
}
