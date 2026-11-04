/**
 * What a person can read and use on a page, from its accessibility tree.
 *
 * Two builds of one app are compared on this, so it keeps only what a person sees: the accessible
 * name, the value, the element's own text, and the checked, selected, disabled, expanded and pressed
 * states. Refs, layout, test ids, source locations and component names change between builds with
 * nothing visible changing, so they are removed. Focus is removed too: it moves with timing.
 *
 * One line for each element that shows something, in page order. Case is folded, spacing is folded,
 * and an ellipsis is dropped, because a cut at another width is not a change in content.
 */

/** The accessible name: the first quoted part after the role, up to the next field. */
const NAME = /^\s*- \S+ "(.*?)"(?= \(ref=| \[|$)/;
/** A quoted field, up to the next field. */
const quotedField = (field: string): RegExp => new RegExp(`\\[${field}="(.*?)"\\](?= \\[| \\(|$)`);
const VALUE = quotedField('value');
const OWN_TEXT = quotedField('text');
/** The state group the snapshot writes, such as `[disabled,checked]`. */
const STATES = /\[((?:[a-z]+)(?:,[a-z]+)*)\]/g;
/** The states a person can see on a control. */
const SHOWN_STATES: ReadonlySet<string> = new Set([
  'checked',
  'selected',
  'disabled',
  'expanded',
  'pressed',
]);
/** A state the snapshot writes that moves with timing, not with the build. */
const UNSHOWN_STATE = 'focused';
const ELLIPSIS = '…';
const VALUE_JOIN = ' = ';

const fold = (text: string): string =>
  text.toLowerCase().replaceAll(ELLIPSIS, '').split(/\s+/).filter(Boolean).join(' ');

function statesOf(line: string): string[] {
  const found: string[] = [];
  for (const match of line.matchAll(STATES)) {
    const group = (match[1] ?? '').split(',');
    // A group with any word that is not a state is another field, for example `[grid]`.
    if (group.every((word) => SHOWN_STATES.has(word) || UNSHOWN_STATE === word)) {
      found.push(...group.filter((word) => SHOWN_STATES.has(word)));
    }
  }
  return found;
}

/** The visible line for one tree line, or '' when the element shows nothing. */
function visibleLine(line: string): string {
  const name = fold(NAME.exec(line)?.[1] ?? '');
  const value = fold(VALUE.exec(line)?.[1] ?? '');
  const text = fold(OWN_TEXT.exec(line)?.[1] ?? '');
  const states = statesOf(line);
  const parts: string[] = [];
  if (name.length > 0) {
    parts.push(name);
  }
  if (text.length > 0) {
    parts.push(text);
  }
  let out = parts.join(' ');
  if (value.length > 0) {
    out = out.length > 0 ? `${out}${VALUE_JOIN}${value}` : value;
  }
  if (states.length > 0) {
    const shown = `[${states.join(',')}]`;
    out = out.length > 0 ? `${out} ${shown}` : shown;
  }
  return out;
}

/** The visible content of an accessibility tree, one line for each element that shows something. */
export function visibleLines(tree: string): string[] {
  return tree
    .split('\n')
    .map(visibleLine)
    .filter((line) => line.length > 0);
}
