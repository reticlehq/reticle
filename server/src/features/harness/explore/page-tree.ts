/**
 * A page as the exploratory Harness reads it: one full snapshot, and the controls on it that a
 * person hunting for something would try — nav links, toggles and tabs, and whatever the journey
 * names. Pure over the snapshot's line format (core's `snapshot-tree.ts`); no browser here.
 */
import { RETICLE_URL_PARAM, ReticleTool, asRecord } from '@reticlehq/core';

export type Invoke = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** One element line: `  - button "Team" (ref=e252) [pressed]`. */
export interface TreeLine {
  depth: number;
  role: string;
  name: string;
  ref?: string;
  states: string[];
  /** The element's own text, `[text="…"]`, when it has no name to carry it. */
  text?: string;
  /** The roles of the lines it sits inside, nearest last. */
  within: string[];
}

export interface PageRead {
  route: string;
  tree: string;
}

const LINE = /^(\s*)-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$/;
const REF = /\(ref=(e\d+)\)/;
const STATES = /\[([a-z,]+)\]\s*$/;
const OWN_TEXT = /\[text="((?:[^"\\]|\\.)*)"\]/;

export function parseTree(tree: string): TreeLine[] {
  const out: TreeLine[] = [];
  const stack: { depth: number; role: string }[] = [];
  for (const raw of tree.split('\n')) {
    const m = LINE.exec(raw);
    if (null === m) continue;
    const depth = (m[1] ?? '').length;
    while (0 < stack.length && (stack.at(-1)?.depth ?? 0) >= depth) stack.pop();
    const rest = m[4] ?? '';
    const ref = REF.exec(rest)?.[1];
    const text = OWN_TEXT.exec(rest)?.[1];
    out.push({
      depth,
      role: m[2] ?? '',
      name: m[3] ?? '',
      ...(ref === undefined ? {} : { ref }),
      ...(text === undefined ? {} : { text }),
      states: (STATES.exec(rest)?.[1] ?? '').split(',').filter((s) => 0 < s.length),
      within: stack.map((s) => s.role),
    });
    stack.push({ depth, role: m[2] ?? '' });
  }
  return out;
}

/** The page's own address: path, query and hash, without the parameters Reticle adds. */
export function routeOf(route: string): string {
  const [pathAndQuery = '', ...hash] = route.split('#');
  const [path = '', query] = pathAndQuery.split('?');
  const ours = Object.values(RETICLE_URL_PARAM) as string[];
  const kept = (query ?? '')
    .split('&')
    .filter((pair) => 0 < pair.length && !ours.some((p) => pair.startsWith(`${p}=`)))
    .join('&');
  return `${path || '/'}${0 === kept.length ? '' : `?${kept}`}${0 === hash.length ? '' : `#${hash.join('#')}`}`;
}

/** The same page with no query: a search or a filter undone. */
export function withoutQuery(route: string): string {
  const [pathAndQuery = '', ...hash] = route.split('#');
  const path = pathAndQuery.split('?')[0] ?? '';
  return `${0 === path.length ? '/' : path}${0 === hash.length ? '' : `#${hash.join('#')}`}`;
}

/** Read the page in full. Undefined when it cannot be read. */
export async function readPage(invoke: Invoke): Promise<PageRead | undefined> {
  try {
    const result = asRecord(await invoke(ReticleTool.SNAPSHOT, { mode: 'full' }));
    const tree = result['tree'];
    const route = asRecord(result['status'])['route'];
    return 'string' === typeof tree
      ? { tree, route: routeOf('string' === typeof route ? route : '/') }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Names the hunt never presses: each is a write, or leaves the session. The action tool's own
 * destructive-action gate still applies; this keeps the search from even asking.
 */
const NEVER_PRESSED =
  /\b(?:sign ?out|log ?out|delete|remove|leave|revoke|join|cancel|archive|reset|disconnect|accept|decline|mark as|resolve|ignore|invite|pay|buy|upgrade|save|submit|send|create|new)\b/i;

const pressable = (line: TreeLine): line is TreeLine & { ref: string } =>
  line.ref !== undefined && 0 < line.name.length && !NEVER_PRESSED.test(line.name);

const NAV_LANDMARKS = new Set(['navigation', 'complementary', 'banner']);
const TOGGLE_ROLES = new Set(['tab', 'radio', 'switch']);
const TOGGLE_GROUPS = new Set(['group', 'toolbar', 'radiogroup', 'tablist']);
/** Roles that, open, make the rest of the page inert to a reader. */
const OVERLAYS = new Set(['menu', 'dialog', 'alertdialog', 'listbox']);

/** Whether a menu or dialog is open, so the read shows it and little else. */
export function overlayOpen(lines: readonly TreeLine[]): boolean {
  return lines.some((l) => OVERLAYS.has(l.role));
}
const PRESSED = 'pressed';
const CHECKED = 'checked';

/** Links in the app's navigation: where a person goes to look around. */
export function navLinks(lines: readonly TreeLine[]): (TreeLine & { ref: string })[] {
  return lines.filter(
    (l): l is TreeLine & { ref: string } =>
      'link' === l.role && l.within.some((r) => NAV_LANDMARKS.has(r)) && pressable(l),
  );
}

/**
 * Toggles and tabs not already on: a button beside a pressed sibling (Mine | Team), and tabs, radios
 * and switches. Pressing one changes what the page shows without leaving it.
 */
export function toggles(lines: readonly TreeLine[]): (TreeLine & { ref: string })[] {
  return lines.filter((l, i): l is TreeLine & { ref: string } => {
    if (!pressable(l) || l.states.includes(PRESSED) || l.states.includes(CHECKED)) return false;
    if (TOGGLE_ROLES.has(l.role)) return true;
    // Only inside a group of its kind (Mine | Team, Map | List). A banner's "Hide sidebar" is
    // pressed too, and the workspace switcher beside it was pressed as a toggle on a live drive.
    if ('button' !== l.role || !TOGGLE_GROUPS.has(l.within.at(-1) ?? '')) return false;
    const siblings = [lines[i - 1], lines[i + 1]].filter(
      (s): s is TreeLine => s !== undefined && s.depth === l.depth && 'button' === s.role,
    );
    return siblings.some((s) => s.states.includes(PRESSED));
  });
}

/** Shortest name matched against the journey's words; shorter ones match by accident. */
const MIN_NAMED = 4;
const ROLES_FOLLOWED = new Set(['link', 'button', 'menuitem', 'tab']);

/**
 * Controls the journey names ("open Account, choose Settings, then Members and access"): the plan
 * is a hint, and these are where it points. A name like `Account: Leo Martin · Pro` matches on the
 * part before its colon.
 */
export function namedControls(
  lines: readonly TreeLine[],
  journey: string,
): (TreeLine & { ref: string })[] {
  const said = journey.toLowerCase();
  return lines.filter(
    (l): l is TreeLine & { ref: string } =>
      ROLES_FOLLOWED.has(l.role) && pressable(l) && journeyNames(said, l.name),
  );
}

/** Whether the journey names a control: its name, or the part before its colon, as whole words. */
export function journeyNames(journey: string, name: string): boolean {
  const head = (name.split(':')[0] ?? '').trim().toLowerCase();
  return (
    MIN_NAMED <= head.length && new RegExp(`\\b${escape(head)}\\b`).test(journey.toLowerCase())
  );
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Roles a person acts on rather than reads. */
const INTERACTIVE = new Set([
  'link',
  'button',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'switch',
  'combobox',
  'option',
  'menuitem',
  'tab',
  'slider',
  'spinbutton',
]);

/** The words a page shows, as a reader would list them: headings, text and labels, not controls. */
export function textsOf(lines: readonly TreeLine[], max: number): string[] {
  const words = lines.flatMap((l) => [
    ...(INTERACTIVE.has(l.role) || 0 === l.name.length ? [] : [l.name]),
    ...(l.text === undefined ? [] : [l.text]),
  ]);
  return [...new Set(words)].slice(0, max);
}
