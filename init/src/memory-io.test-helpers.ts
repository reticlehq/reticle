/**
 * A compact in-memory `InitIo` for the onboarding tests that drive `runInit` end to end.
 *
 * Deliberately smaller than the one `run.test.ts` carries: these tests need reads, writes, prints,
 * scoping and absolute paths (a workspace root ABOVE the app is read by absolute path), and nothing
 * the runner does with subprocesses beyond reporting them as successful.
 *
 * A `.test-helpers.ts` module, not a `.test.ts` one, so vitest does not collect it as a suite.
 */
import { SILENT_HOST } from './host.js';
import type { InitIo } from './run.js';

export const TEST_PAIRING_TOKEN = 'a1b2c3d4e5f6';

export interface MemoryIo extends InitIo {
  readonly written: Record<string, string>;
  readonly lines: string[];
}

interface Sinks {
  readonly written: Record<string, string>;
  readonly lines: string[];
}

export function memoryIo(
  files: Record<string, string>,
  prefix = '',
  sinks: Sinks = { written: {}, lines: [] },
): MemoryIo {
  const { written, lines } = sinks;
  // Forward slashes whatever the platform: production joins paths with `path.join`, which yields
  // backslashes on Windows, and these fixtures are written POSIX-style.
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
  const key = (raw: string): string => {
    const p = norm(raw);
    if ('.' === p) return '' === prefix ? '.' : prefix;
    return p.startsWith('/') || '' === prefix ? p : `${prefix}/${p}`;
  };
  const all = (): string[] => [...new Set([...Object.keys(files), ...Object.keys(written)])];
  const children = (rel: string, dirs: boolean): string[] => {
    const base = key(rel);
    const scope = '.' === base ? '' : `${base}/`;
    const names = all()
      .filter((p) => p.startsWith(scope))
      .map((p) => p.slice(scope.length))
      .filter((p) => p !== '' && dirs === p.includes('/'))
      .map((p) => p.split('/')[0] ?? '');
    return [...new Set(names)].filter((n) => n !== '');
  };
  return {
    written,
    lines,
    readFile: (p) => written[key(p)] ?? files[key(p)] ?? null,
    writeFile: (p, c) => {
      written[key(p)] = c;
    },
    exists: (p) => key(p) in files || key(p) in written,
    canWrite: () => true,
    homeDir: () => '/home/u',
    cwd: () => ('' === prefix ? '/project' : `/project/${prefix}`),
    rootFiles: () => children('.', false),
    listDirs: (rel) => children(rel, true),
    listFiles: (rel) => children(rel, false),
    scoped: (rel) => memoryIo(files, key(rel), sinks),
    exec: () => true,
    probe: () => true,
    print: (l) => lines.push(l),
    host: { ...SILENT_HOST, pairingToken: () => TEST_PAIRING_TOKEN },
  };
}
