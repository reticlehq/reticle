/**
 * TOON — Token-Optimized Object Notation.
 *
 * A compact, deterministic, line-oriented text format for Reticle snapshots and query results.
 * This is a ONE-WAY, encode-only projection of the internal JSON representation (there is no decoder
 * back to JSON — the agent reads TOON, it is never parsed back). Not a binary format — Claude must be
 * able to generate and read it reliably from its training data alone.
 *
 * Grammar (one element per line):
 * type ref "name" [states] key=value...
 *
 * Element types (abbreviated roles):
 * btn button inp textbox/input sel combobox/listbox chk checkbox
 * rad radio lnk link img img dlg dialog/alertdialog
 * nav navigation lst list/listbox tab tab/tabpanel hdr heading
 * frm form mn menu/menubar fld group/fieldset el (any other role)
 *
 * State flags (inside []):
 * vis visible hid hidden en enabled dis disabled
 * chk checked exp expanded focus focused
 * (`present` is on every element, so it is never encoded — see STATE_FLAG.)
 *
 * Attributes (key=value, space-separated):
 * val="..." current value of the element
 * count=N child count (for containers, replaces expanding children)
 * ph="..." placeholder text
 */

import { ElementState } from './constants.js';

/** Encode an ElementDescriptor to a TOON line. */
export interface ToonElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  states?: string[];
  visible?: boolean;
  text?: string;
  children?: ToonElement[];
  childCount?: number;
}

const ROLE_MAP: Record<string, string> = {
  button: 'btn',
  textbox: 'inp',
  search: 'inp',
  checkbox: 'chk',
  radio: 'rad',
  link: 'lnk',
  img: 'img',
  dialog: 'dlg',
  alertdialog: 'dlg',
  navigation: 'nav',
  list: 'lst',
  listbox: 'lst',
  listitem: 'li',
  combobox: 'sel',
  option: 'opt',
  tab: 'tab',
  tabpanel: 'tab',
  heading: 'hdr',
  form: 'frm',
  menu: 'mn',
  menubar: 'mn',
  menuitem: 'mi',
  group: 'fld',
  fieldset: 'fld',
  table: 'tbl',
  row: 'row',
  cell: 'cel',
  main: 'main',
  banner: 'hdr',
  grid: 'grd',
  gridcell: 'cel',
  tree: 'tree',
  treeitem: 'titem',
  switch: 'sw',
  slider: 'sldr',
  spinbutton: 'spin',
};

function abbreviateRole(role: string): string {
  return ROLE_MAP[role] ?? 'el';
}

/**
 * Short flags for the states the SDK reports.
 *
 * `present` is deliberately absent: `getStates` seeds every element's array with it, so it is true
 * of everything that could appear here and encodes nothing — while costing eight characters per
 * element in the layer whose entire job is cutting the agent's token bill. `visible`/`hidden` are
 * likewise absent because the `visible` field already carries them.
 *
 * An unlisted state falls through to its own name, so an SDK newer than this daemon still reaches
 * the agent with something readable instead of losing the state.
 */
const STATE_FLAG: Partial<Record<ElementState, string>> = {
  [ElementState.ENABLED]: 'en',
  [ElementState.DISABLED]: 'dis',
  [ElementState.CHECKED]: 'chk',
  [ElementState.EXPANDED]: 'exp',
  [ElementState.FOCUSED]: 'focus',
};

/** States the `visible` field already encodes, plus the one that is true of everything. */
const UNENCODED_STATES: ReadonlySet<string> = new Set<string>([
  ElementState.PRESENT,
  ElementState.VISIBLE,
  ElementState.HIDDEN,
]);

function encodeStates(states: string[], visible?: boolean): string {
  const flags: string[] = [];
  if (true === visible) flags.push('vis');
  else if (false === visible) flags.push('hid');
  for (const s of states) {
    if (UNENCODED_STATES.has(s)) continue;
    flags.push(STATE_FLAG[s as ElementState] ?? s);
  }
  return flags.length > 0 ? `[${flags.join(',')}]` : '';
}

/** Coerce a wire field to a string. resultToToon receives UNVALIDATED wire data cast to ToonElement,
 * so a missing/numeric `name` must not make `.replace` throw and lose the whole encode. */
function toText(v: unknown): string {
  if ('string' === typeof v) return v;
  if ('number' === typeof v || 'boolean' === typeof v || 'bigint' === typeof v) return String(v);
  return ''; // undefined / null / object / symbol have no representable text on a wire field
}

function encodeName(name: unknown): string {
  return `"${toText(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function encodeValue(val: unknown): string {
  return `"${toText(val).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function encodeLine(el: ToonElement, depth: number): string {
  const indent = '  '.repeat(depth);
  const type = abbreviateRole(el.role);
  const states = encodeStates(Array.isArray(el.states) ? el.states : [], el.visible);
  const ref = toText(el.ref) || '?';
  const parts: string[] = [indent + type, ref, encodeName(el.name), ...(states ? [states] : [])];
  if ('string' === typeof el.value && el.value.length > 0)
    parts.push(`val=${encodeValue(el.value)}`);
  if (el.childCount !== undefined) parts.push(`count=${String(el.childCount)}`);
  return parts.join(' ');
}

function encodeTree(elements: ToonElement[], depth = 0): string {
  const lines: string[] = [];
  for (const el of elements) {
    // A single malformed element must not lose the rest of the tree — fall back to a placeholder line.
    try {
      lines.push(encodeLine(el, depth));
      if (Array.isArray(el.children) && el.children.length > 0) {
        lines.push(encodeTree(el.children, depth + 1));
      }
    } catch {
      lines.push(`${'  '.repeat(depth)}el ? "[unencodable]"`);
    }
  }
  return lines.join('\n');
}

/** Encode an array of ElementDescriptor-shaped objects to TOON text. */
export function toToon(elements: ToonElement[]): string {
  if (0 === elements.length) return '# TOON v1 — empty';
  return `# TOON v1\n${encodeTree(elements)}`;
}

/** Encode a single reticle_snapshot or reticle_query result object to TOON. */
export function resultToToon(result: Record<string, unknown>): string {
  const elements = result['elements'];
  if (!Array.isArray(elements)) return JSON.stringify(result);
  return toToon(elements as ToonElement[]);
}

/** Whether a tool result object should be encoded as TOON (has an elements array). */
export function isToonable(result: unknown): boolean {
  return (
    'object' === typeof result &&
    result !== null &&
    !Array.isArray(result) &&
    Array.isArray((result as Record<string, unknown>)['elements'])
  );
}
