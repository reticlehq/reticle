import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

/**
 * Two guards that keep Reticle's own development off its telemetry.
 *
 * `.env` is the convenient one and is useful to every user: put `RETICLE_TELEMETRY=0` in a project's
 * `.env` and the daemon honours it. But `.env` is gitignored, so it exists only on the machine that
 * created it — a fresh clone of this repo would phone home on the first `reticle serve` a
 * contributor runs. `isReticleSourceCheckout` closes that: the marker is the committed root
 * package.json, so the guarantee travels with the repository instead of with one developer's
 * untracked file.
 */

/** The monorepo's root package name — the one committed marker that says "this IS Reticle". */
const MONOREPO_NAME = 'reticle-monorepo';

/** Walk up from `cwd` to the filesystem root, looking for a package.json that names this monorepo. */
export function isReticleSourceCheckout(cwd: string): boolean {
  let dir = cwd;
  const { root } = parse(cwd);
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(pkg, 'utf8'));
        const name =
          'object' === typeof parsed && parsed !== null
            ? (parsed as { name?: unknown }).name
            : undefined;
        if (name === MONOREPO_NAME) return true;
      } catch {
        /* an unreadable/!JSON package.json simply is not the marker */
      }
    }
    if (dir === root) return false;
    const next = dirname(dir);
    if (next === dir) return false;
    dir = next;
  }
}

/** Strip one layer of matching quotes from a .env value. */
function unquote(value: string): string {
  const first = value[0];
  if (('"' === first || "'" === first) && value.endsWith(first) && value.length >= 2) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Load `<dir>/.env` into `env`. Best-effort and deliberately minimal — no expansion, no multiline.
 *
 * A variable already present in the environment ALWAYS wins. A .env that overrode an explicit
 * `RETICLE_PORT` from the caller's shell would bind the daemon somewhere the caller never asked for,
 * which is a worse surprise than the convenience is worth.
 */
export function loadDotEnv(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  const file = join(dir, '.env');
  let text: string;
  try {
    if (!existsSync(file)) return;
    text = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (0 === line.length || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue; // not a KEY=value pair — skip rather than fail the whole file
    const key = line.slice(0, eq).trim();
    if (0 === key.length || env[key] !== undefined) continue;
    env[key] = unquote(line.slice(eq + 1).trim());
  }
}
