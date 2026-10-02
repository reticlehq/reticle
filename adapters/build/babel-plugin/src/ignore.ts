import { RETICLE_IGNORE_MARKER } from '@reticlehq/core/source-constants';

/**
 * Is this file opted out of source stamping?
 *
 * True when the FIRST non-empty line is a comment carrying `@reticle-ignore` — the line form, the
 * block form, or the HTML form a `.svelte` file needs because it has no line for a `//` before its
 * markup. Position is strict: a license header on line 1 and the marker on line 2 is not an opt-out,
 * so the rule can be checked at a glance and documented in one sentence. The word is strict too:
 * the comment's whole content must BE the marker, so `@reticle-ignore-next-line` is not this.
 *
 * Shared by the Babel plugin (which covers Vite, `@reticlehq/next` and direct Babel users) and the
 * Vite plugin (which also owns the Svelte stamper), so there is one reading of the marker. The
 * marker string itself is a core constant for the same reason (#853).
 */
export function isSourceStampingIgnored(code: string): boolean {
  const line = firstNonEmptyLine(code);
  if (line === undefined) return false;
  const content = commentContent(line);
  return content === RETICLE_IGNORE_MARKER;
}

function firstNonEmptyLine(code: string): string | undefined {
  for (const raw of code.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length > 0) return line;
  }
  return undefined;
}

/** The text inside a one-line comment, trimmed — or undefined when the line is not one. */
function commentContent(line: string): string | undefined {
  if (line.startsWith('//')) return line.slice(2).trim();
  if (line.startsWith('/*') && line.endsWith('*/')) return line.slice(2, -2).trim();
  if (line.startsWith('<!--') && line.endsWith('-->')) return line.slice(4, -3).trim();
  return undefined;
}
