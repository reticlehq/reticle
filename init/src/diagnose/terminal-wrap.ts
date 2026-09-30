/**
 * Setup output, laid out for the person reading it in a terminal.
 *
 * Setup's sentences are written one per line and were printed as they are, so a paragraph ran off
 * the right edge and the terminal broke it mid-word, or they were broken by hand at a width that
 * matched nobody's window. This wraps at the reader's real width instead, keeping each line's indent
 * and hanging continuation lines under a list marker, so a numbered step still reads as one step.
 *
 * Commands are never wrapped: a command split across two lines is one nobody can paste. And output
 * that is not going to a terminal — an agent reading a pipe — is left exactly as written.
 */

/** Narrow enough to read, wide enough that a step is not ten lines tall. */
const MAX_WIDTH = 100;
const MIN_WIDTH = 40;

/** A line a reader runs rather than reads. */
const COMMAND = /^\s*(?:\$ |npx |npm |pnpm |yarn |bun |reticle |curl |cd |export |import )/;
/** What a continuation line hangs under: `1. `, `- `, `• `, `✓ `, `⚠ `, `why: `, `[✓] `. */
const MARKER = /^(\s*)(\d+\.\s+|[-•✓⚠]\s+|why:\s+|\[.\]\s+)?/u;

/** The width to wrap at, or undefined when stdout is not a terminal. */
export function terminalWidth(
  stream: { isTTY?: boolean; columns?: number } = process.stdout,
): number | undefined {
  if (true !== stream.isTTY || stream.columns === undefined) return undefined;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, stream.columns - 1));
}

function wrapLine(line: string, width: number): string {
  if (line.length <= width || COMMAND.test(line)) return line;
  const match = MARKER.exec(line);
  const lead = match?.[0] ?? '';
  const hang = ' '.repeat(lead.length);
  const words = line
    .slice(lead.length)
    .split(' ')
    .filter((w) => w.length > 0);
  // A path or URL wider than the window cannot be kept whole by wrapping, and breaking the words
  // around it only strands its label on a line of its own. The terminal's own wrap does better.
  if (words.some((w) => hang.length + w.length > width)) return line;
  const out: string[] = [];
  let current = lead;
  let prefix = lead;
  for (const word of words) {
    if (current.length > prefix.length && current.length + 1 + word.length > width) {
      out.push(current);
      prefix = hang;
      current = hang + word;
    } else {
      current = current.length > prefix.length ? `${current} ${word}` : current + word;
    }
  }
  out.push(current);
  return out.join('\n');
}

/** `text` wrapped line by line to `width`; unchanged when `width` is undefined. */
export function wrapForTerminal(text: string, width: number | undefined): string {
  if (width === undefined) return text;
  return text
    .split('\n')
    .map((line) => wrapLine(line, width))
    .join('\n');
}
