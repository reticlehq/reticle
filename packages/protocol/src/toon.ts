/**
 * TOON — Token-Optimized Object Notation.
 *
 * A compact, deterministic, line-oriented text format for Reticle snapshots and query results.
 * Losslessly round-trips to/from the internal JSON representation. Not a binary format — Claude
 * must be able to generate and parse it reliably from its training data alone.
 *
 * Grammar (one element per line):
 *   type ref "name" [states] key=value ...
 *
 * Element types (abbreviated roles):
 *   btn  button      inp  textbox/input   sel  combobox/listbox    chk  checkbox
 *   rad  radio       lnk  link            img  img                 dlg  dialog/alertdialog
 *   nav  navigation  lst  list/listbox    tab  tab/tabpanel        hdr  heading
 *   frm  form        mn   menu/menubar    fld  group/fieldset      el   (any other role)
 *
 * State flags (inside []):
 *   vis  visible     hid  hidden          en   enabled             dis  disabled
 *   chk  checked     uch  unchecked       exp  expanded            col  collapsed   focus
 *
 * Attributes (key=value, space-separated):
 *   val="..."   current value of the element
 *   count=N     child count (for containers, replaces expanding children)
 *   ph="..."    placeholder text
 */

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

function encodeStates(states: string[], visible?: boolean): string {
  const flags: string[] = [];
  if (visible === true) flags.push('vis');
  else if (visible === false) flags.push('hid');
  for (const s of states) {
    switch (s) {
      case 'visible':
        break; // handled above
      case 'hidden':
        break; // handled above
      case 'enabled':
        flags.push('en');
        break;
      case 'disabled':
        flags.push('dis');
        break;
      case 'checked':
        flags.push('chk');
        break;
      case 'unchecked':
        flags.push('uch');
        break;
      case 'expanded':
        flags.push('exp');
        break;
      case 'collapsed':
        flags.push('col');
        break;
      case 'focused':
        flags.push('focus');
        break;
      default:
        flags.push(s);
    }
  }
  return flags.length > 0 ? `[${flags.join(',')}]` : '';
}

function encodeName(name: string): string {
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function encodeValue(val: string): string {
  return `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function encodeLine(el: ToonElement, depth: number): string {
  const indent = '  '.repeat(depth);
  const type = abbreviateRole(el.role);
  const states = encodeStates(el.states ?? [], el.visible);
  const parts: string[] = [indent + type, el.ref, encodeName(el.name), ...(states ? [states] : [])];
  if (el.value !== undefined && el.value.length > 0) parts.push(`val=${encodeValue(el.value)}`);
  if (el.childCount !== undefined) parts.push(`count=${String(el.childCount)}`);
  return parts.join(' ');
}

function encodeTree(elements: ToonElement[], depth = 0): string {
  const lines: string[] = [];
  for (const el of elements) {
    lines.push(encodeLine(el, depth));
    if (el.children && el.children.length > 0) {
      lines.push(encodeTree(el.children, depth + 1));
    }
  }
  return lines.join('\n');
}

/** Encode an array of ElementDescriptor-shaped objects to TOON text. */
export function toToon(elements: ToonElement[]): string {
  if (elements.length === 0) return '# TOON v1 — empty';
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
    typeof result === 'object' &&
    result !== null &&
    !Array.isArray(result) &&
    Array.isArray((result as Record<string, unknown>)['elements'])
  );
}
