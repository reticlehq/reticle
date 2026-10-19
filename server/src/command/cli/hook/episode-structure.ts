/**
 * The page's structure at each step, without its text: what a dataset can carry.
 *
 * The episode log keeps each `reticle_snapshot` result whole, on the machine. An export needs the
 * shape of the page (roles, nesting, refs, layout, form state) and none of its words: accessible
 * names, values and text are the customer's data. `structureOfTree` reads the snapshot's line format
 * from the END of each line, and copies only what it can check against a fixed vocabulary or a
 * fixed pattern (a role token, `e<n>`, a grid layout, a known state). Everything else becomes a
 * boolean, so a word can never pass through, however a line is shaped.
 *
 * `reticle hook export --structure` writes one JSON line per snapshot step to stdout.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ElementState, ReticleDir } from '@reticlehq/core';

export interface StructureNode {
  depth: number;
  role: string;
  ref?: string;
  /** Had an accessible name. The name itself is never kept. */
  named?: boolean;
  /** Had a form value. */
  valued?: boolean;
  /** Had its own text. */
  texted?: boolean;
  /** A grid container's track signature (CSS, not page text). */
  layout?: string;
  states?: string[];
}

const LINE = /^((?: {2})*)- ([a-z][a-z-]*)(.*)$/;
const INDENT = 2;
const STATES: ReadonlySet<string> = new Set([
  ElementState.DISABLED,
  ElementState.CHECKED,
  ElementState.EXPANDED,
  ElementState.PRESSED,
  ElementState.FOCUSED,
]);
const STATE_SUFFIX = / \[([a-zA-Z,]+)\]$/;
const LAYOUT_SUFFIX = / \[(grid(?:-cols:[^\]"]*)?)\]$/;
const REF_SUFFIX = / \(ref=(e\d+)\)$/;
const TEXT_FIELD = ' [text="';
const VALUE_FIELD = ' [value="';
const FIELD_END = '"]';
/** The snapshot role for a generic container's bare text line. */
const TEXT_ROLE = 'text';
const SNAPSHOT_TOOL = 'reticle_snapshot';

/** One snapshot tree as text-free nodes. Lines that are not snapshot lines are dropped. */
export function structureOfTree(tree: string): StructureNode[] {
  const nodes: StructureNode[] = [];
  for (const line of tree.split('\n')) {
    const match = LINE.exec(line);
    if (null === match) continue;
    const [, indent = '', role = '', tail = ''] = match;
    const node: StructureNode = { depth: indent.length / INDENT, role };
    let rest = tail;
    const states = STATE_SUFFIX.exec(rest);
    const named = states?.[1]?.split(',') ?? [];
    if (states !== null && 0 < named.length && named.every((s) => STATES.has(s))) {
      node.states = named;
      rest = rest.slice(0, states.index);
    }
    const layout = LAYOUT_SUFFIX.exec(rest);
    if (layout !== null) {
      node.layout = layout[1] ?? '';
      rest = rest.slice(0, layout.index);
    }
    for (const [field, flag] of [
      [TEXT_FIELD, 'texted'],
      [VALUE_FIELD, 'valued'],
    ] as const) {
      const at = rest.lastIndexOf(field);
      if (-1 !== at && rest.endsWith(FIELD_END)) {
        node[flag] = true;
        rest = rest.slice(0, at);
      }
    }
    const ref = REF_SUFFIX.exec(rest);
    if (ref !== null) {
      node.ref = ref[1] ?? '';
      rest = rest.slice(0, ref.index);
    }
    if (rest.startsWith(' "')) {
      if (TEXT_ROLE === role) node.texted = true;
      else node.named = true;
    }
    nodes.push(node);
  }
  return nodes;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  'object' === typeof value && null !== value && !Array.isArray(value);

/**
 * Every snapshot step in a project's episodes, as structure lines handed to `write`. A result the
 * episode cut short holds no whole tree and is counted, never guessed at.
 */
export function exportStructure(
  reticleRoot: string,
  write: (line: string) => void,
): { steps: number; skippedCut: number } {
  const dir = join(reticleRoot, ReticleDir.EPISODES_SUBDIR);
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith('.jsonl'));
  } catch {
    return { steps: 0, skippedCut: 0 };
  }
  let steps = 0;
  let skippedCut = 0;
  for (const file of files) {
    let episodeId: unknown;
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObject(record)) continue;
      if (record['episodeId'] !== undefined) episodeId = record['episodeId'];
      if (SNAPSHOT_TOOL !== record['tool']) continue;
      const result = record['result'];
      const tree = isObject(result) ? result['tree'] : undefined;
      if ('string' !== typeof tree) {
        if (Array.isArray(record['truncated'])) skippedCut += 1;
        continue;
      }
      steps += 1;
      write(
        JSON.stringify({
          episodeId,
          n: record['n'],
          tool: record['tool'],
          sessionId: record['sessionId'],
          startedAt: record['startedAt'],
          structure: structureOfTree(tree),
        }),
      );
    }
  }
  return { steps, skippedCut };
}
