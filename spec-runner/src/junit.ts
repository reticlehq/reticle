import type { FileSystemPort } from '@reticlehq/server';
import { DEFAULT_JUNIT_SUITE_NAME, JUnit, TestStatus } from './constants.js';
import { summarize } from './summary.js';
import type { SpecResult } from './types.js';

/**
 * XML 1.0 section 2.2, the whole `Char` production:
 *
 *   #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
 *
 * Stated as codes rather than a regex character class, which cannot express control characters
 * without tripping `no-control-regex` and needing the rule turned off to read it.
 *
 * Iterating code points also means an astral character (an emoji in a test name) survives intact;
 * the regex worked on UTF-16 units.
 *
 * Only the LOWER bound used to be enforced, which left the production's two upper holes open:
 * the surrogate block, and the noncharacters U+FFFE and U+FFFF. A test name or an assertion message
 * carrying U+FFFF produced a document a real parser rejects outright ("disallowed character"), which
 * is the same outcome the strip exists to prevent: CI shows nothing instead of showing the failure.
 * A lone surrogate is the milder case, since writing the file as UTF-8 turns it into U+FFFD, but it
 * is illegal by the same clause and dropping it keeps the rule one thing rather than two.
 */
const XML_MIN_LEGAL_CODE = 0x20;
const XML_LEGAL_CONTROL_CODES: ReadonlySet<number> = new Set([
  0x09, // tab
  0x0a, // newline
  0x0d, // carriage return
]);
/** The surrogate block: legal only as a PAIR, which iteration has already resolved to one code point. */
const XML_SURROGATE_FIRST = 0xd800;
const XML_SURROGATE_LAST = 0xdfff;
/** U+FFFE and U+FFFF are noncharacters; the production stops the BMP at U+FFFD. */
const XML_BMP_LAST_LEGAL = 0xfffd;
const XML_ASTRAL_FIRST = 0x10000;

function isXmlLegal(code: number): boolean {
  if (XML_LEGAL_CONTROL_CODES.has(code)) return true;
  if (code < XML_MIN_LEGAL_CODE) return false;
  if (code >= XML_SURROGATE_FIRST && code <= XML_SURROGATE_LAST) return false;
  return code <= XML_BMP_LAST_LEGAL || code >= XML_ASTRAL_FIRST;
}

/** Drop the characters no XML parser will accept. */
function stripXmlIllegal(value: string): string {
  let out = '';
  for (const ch of value) {
    if (isXmlLegal(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out;
}

/**
 * Strip characters illegal in XML 1.0 then escape the five XML-significant characters. Without the
 * strip, ANSI colour codes in error output produce a document no parser will read — CI shows
 * nothing instead of showing the failure.
 */
function escapeXml(value: string): string {
  return stripXmlIllegal(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** First line of text (for the attribute summary). Handles LF, CRLF, and bare CR. */
function firstLine(text: string): string {
  const match = /\r?\n|\r/.exec(text);
  return null === match ? text : text.slice(0, match.index);
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

function caseXml(r: SpecResult): string {
  const open =
    `  <${JUnit.CASE} ${JUnit.ATTR_NAME}="${escapeXml(r.name)}" ` +
    `${JUnit.ATTR_TIME}="${seconds(r.durationMs)}">`;
  if (r.status === TestStatus.FAIL) {
    const full = escapeXml(r.error ?? '');
    const summary = escapeXml(firstLine(r.error ?? ''));
    return (
      `${open}\n    <${JUnit.FAILURE} ${JUnit.ATTR_MESSAGE}="${summary}">` +
      `${full}</${JUnit.FAILURE}>\n  </${JUnit.CASE}>`
    );
  }
  if (r.status === TestStatus.SKIP) {
    const msg = escapeXml(r.skipReason ?? '');
    return `${open}\n    <${JUnit.SKIPPED} ${JUnit.ATTR_MESSAGE}="${msg}"></${JUnit.SKIPPED}>\n  </${JUnit.CASE}>`;
  }
  return `${open}</${JUnit.CASE}>`;
}

/** Render results as a single JUnit `<testsuite>` document (CI consumable). */
export function toJUnitXml(results: readonly SpecResult[], opts?: { suite?: string }): string {
  const suite = escapeXml(opts?.suite ?? DEFAULT_JUNIT_SUITE_NAME);
  const s = summarize(results);
  const header =
    `<${JUnit.SUITE} ${JUnit.ATTR_NAME}="${suite}" ` +
    `${JUnit.ATTR_TESTS}="${String(s.total)}" ` +
    `${JUnit.ATTR_FAILURES}="${String(s.failed)}" ` +
    `${JUnit.ATTR_SKIPPED}="${String(s.skipped)}">`;
  const body = results.map(caseXml).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n${header}\n${body}\n</${JUnit.SUITE}>\n`;
}

/** Write the JUnit report through the injected filesystem seam (tests pass a fake adapter). */
export async function writeJUnit(
  fs: FileSystemPort,
  path: string,
  results: readonly SpecResult[],
  opts?: { suite?: string },
): Promise<void> {
  await fs.writeFile(path, toJUnitXml(results, opts));
}
