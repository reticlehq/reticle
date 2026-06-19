export interface Baseline {
  name: string;
  lines: string[];
  route: string;
}

export interface DiffResult {
  removed: string[];
  added: string[];
}

/** Strip volatile ref ids so snapshots compare by semantics, not by ref number. */
export function normalizeLines(tree: string): string[] {
  return tree
    .split('\n')
    .map((line) => line.replace(/\s*\(ref=e\d+\)/, '').trim())
    .filter((line) => line.length > 0);
}

function frequency(lines: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
  return map;
}

/** Multiset diff: what's in baseline-but-not-current (removed) and current-but-not-baseline (added). */
export function diffLines(baseline: string[], current: string[]): DiffResult {
  const b = frequency(baseline);
  const c = frequency(current);
  const removed: string[] = [];
  const added: string[] = [];
  for (const [line, n] of b) {
    const have = c.get(line) ?? 0;
    for (let i = 0; i < n - have; i += 1) removed.push(line);
  }
  for (const [line, n] of c) {
    const had = b.get(line) ?? 0;
    for (let i = 0; i < n - had; i += 1) added.push(line);
  }
  return { removed, added };
}

/** In-memory baseline store (per server run). */
export class BaselineStore {
  readonly #map = new Map<string, Baseline>();

  save(baseline: Baseline): void {
    this.#map.set(baseline.name, baseline);
  }

  get(name: string): Baseline | undefined {
    return this.#map.get(name);
  }

  list(): string[] {
    return [...this.#map.keys()];
  }
}
