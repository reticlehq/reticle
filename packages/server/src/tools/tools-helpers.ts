/** Small pure helpers shared by the MCP tool handlers. */

export interface InteractiveItem {
  ref: string;
  desc: string;
}

/** Parse interactive elements (with refs) out of a snapshot tree for exploration. */
export function parseInteractive(tree: string): InteractiveItem[] {
  const items: InteractiveItem[] = [];
  for (const line of tree.split('\n')) {
    const match = /\(ref=(e\d+)\)/.exec(line);
    if (match !== null) {
      items.push({ ref: match[1] ?? '', desc: line.replace(/\s*\(ref=e\d+\)/, '').trim() });
    }
  }
  return items;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
