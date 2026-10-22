/**
 * `doctor`'s coverage rows: what Reticle sees in each connected app, read from the daemon's
 * `/status` (`coverage`), and — once a verdict recorded a gap — the prompt to hand a coding agent.
 * A terminal cannot copy, so the prompt is printed whole, ready to paste.
 */
import { DoctorRow, doctorRow } from './doctor-rows.js';

interface TabCoverage {
  url?: unknown;
  covered?: unknown;
  total?: unknown;
  missing?: unknown;
  notSeenYet?: unknown;
  prompt?: unknown;
}

const capabilitiesIn = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const name: unknown =
          'object' === typeof item && null !== item
            ? (item as Record<string, unknown>)['capability']
            : item;
        return 'string' === typeof name ? [name] : [];
      })
    : [];

/** The rows for every tab the status names; nothing when it names none. Never throws. */
export function coverageLines(status: unknown): string[] {
  const list =
    'object' === typeof status && null !== status
      ? (status as Record<string, unknown>)['coverage']
      : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw: unknown) => {
    const tab = ('object' === typeof raw && null !== raw ? raw : {}) as TabCoverage;
    if ('number' !== typeof tab.covered || 'number' !== typeof tab.total) return [];
    const missing = capabilitiesIn(tab.missing);
    const notSeen = capabilitiesIn(tab.notSeenYet);
    const parts = [
      `${String(tab.covered)}/${String(tab.total)}${'string' === typeof tab.url ? ` at ${tab.url}` : ''}`,
      ...(0 === missing.length ? [] : [`missing: ${missing.join(', ')}`]),
      ...(0 === notSeen.length ? [] : [`not seen yet: ${notSeen.join(', ')}`]),
    ];
    const prompt =
      'string' === typeof tab.prompt
        ? [
            '    prompt for your coding agent (copy it):',
            ...tab.prompt.split('\n').map((line) => `      ${line}`),
          ]
        : [];
    return [doctorRow(DoctorRow.COVERAGE, parts.join(' — ')), ...prompt];
  });
}
