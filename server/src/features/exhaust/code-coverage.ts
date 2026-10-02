/**
 * What of the app's own code ever ran, from the browser Reticle drives.
 *
 * Every other coverage number measures what Reticle already knew about — routes it reached, controls
 * it listed. None can say what NEVER ran, including a branch no screen shows. V8 function coverage
 * can, because it is counted against the app's source rather than against what the driving found.
 *
 * ponytail: FUNCTION coverage, keyed by name and start offset in the served (transformed) module.
 * It needs no source maps and answers "did this handler ever run". Line coverage needs the source
 * map of each module; add it when function granularity proves too coarse.
 */

/** One script as `page.coverage.stopJSCoverage()` reports it — only the fields read here. */
export interface RawScriptCoverage {
  url: string;
  functions: readonly {
    functionName: string;
    ranges: readonly { startOffset: number; endOffset: number; count: number }[];
  }[];
}

/** Per file, per function key: its name and whether it ever ran. JSON-safe so it can persist. */
export type CodeCoverage = Record<string, Record<string, { name: string; executed: boolean }>>;

export interface CodeSummary {
  total: number;
  executed: number;
  files: { file: string; functions: number; executed: number; unexecuted: string[] }[];
}

/** Path segments that are never the app under test. */
// `dist`: built output is not source, and a monorepo serves Reticle's own SDK from it.
const NOT_APP = /(?:^|\/)(?:node_modules|@vite|@id|@react-refresh|@reticlehq|\.vite|dist)(?:\/|$)/;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/;

/** The repo-relative-looking path of an app script, or undefined for anything that is not the app. */
export function appFileOf(url: string): string | undefined {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  if (NOT_APP.test(path) || !SOURCE_FILE.test(path)) return undefined;
  return path.replace(/^\/+/, '');
}

export function emptyCodeCoverage(): CodeCoverage {
  return {};
}

/**
 * Fold one take into the accumulated coverage. A union: a function that ran once stays run, so a
 * reload or a later drive can only add to what is known.
 */
export function foldCodeCoverage(
  into: CodeCoverage,
  take: readonly RawScriptCoverage[],
): CodeCoverage {
  const out: CodeCoverage = { ...into };
  for (const script of take) {
    const file = appFileOf(script.url);
    if (file === undefined) continue;
    const fns = { ...(out[file] ?? {}) };
    for (const f of script.functions) {
      const first = f.ranges[0];
      if (first === undefined) continue;
      // The module's own top-level body is reported as an anonymous function starting at 0. It
      // always runs when the file loads, so counting it would inflate every file by one.
      if ('' === f.functionName && 0 === first.startOffset) continue;
      const key = `${f.functionName}@${String(first.startOffset)}`;
      const ran = first.count > 0 || true === fns[key]?.executed;
      fns[key] = { name: '' === f.functionName ? '(anonymous)' : f.functionName, executed: ran };
    }
    out[file] = fns;
  }
  return out;
}

export function summarizeCode(coverage: CodeCoverage): CodeSummary {
  const files = Object.entries(coverage)
    .map(([file, fns]) => {
      const list = Object.values(fns);
      return {
        file,
        functions: list.length,
        executed: list.filter((f) => f.executed).length,
        unexecuted: list.filter((f) => !f.executed).map((f) => f.name),
      };
    })
    .filter((f) => f.functions > 0)
    .sort((a, b) => a.file.localeCompare(b.file));
  return {
    total: files.reduce((n, f) => n + f.functions, 0),
    executed: files.reduce((n, f) => n + f.executed, 0),
    files,
  };
}
