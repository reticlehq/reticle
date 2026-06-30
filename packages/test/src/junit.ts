import type { FileSystemPort } from '@reticlehq/server';
import { DEFAULT_JUNIT_SUITE_NAME, JUnit, TestStatus } from './constants.js';
import { summarize } from './summary.js';
import type { SpecResult } from './types.js';

/** Escape the five XML-significant characters in attribute values + text. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

function caseXml(r: SpecResult): string {
  const open =
    `  <${JUnit.CASE} ${JUnit.ATTR_NAME}="${escapeXml(r.name)}" ` +
    `${JUnit.ATTR_TIME}="${seconds(r.durationMs)}">`;
  if (r.status === TestStatus.FAIL) {
    const msg = escapeXml(r.error ?? '');
    return `${open}\n    <${JUnit.FAILURE} ${JUnit.ATTR_MESSAGE}="${msg}"></${JUnit.FAILURE}>\n  </${JUnit.CASE}>`;
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
