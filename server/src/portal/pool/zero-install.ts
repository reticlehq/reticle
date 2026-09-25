/**
 * The zero-install reader: how a page whose app never ran `init` still reaches a verdict.
 *
 * `@reticlehq/browser` builds itself into one file (`dist/reticle-inject.js`). The daemon reads that
 * file as TEXT and evaluates it in a leased page that never connected, so the server never imports DOM
 * code and the page needs no build step. What comes back is an ordinary session that reports no
 * framework adapter and no source mapping, which is the honest description of what it can see.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/** The subpath `@reticlehq/browser` exports its single-file build under. */
const READER_SPECIFIER = '@reticlehq/browser/inject';

export interface InjectedConnect {
  url: string;
  /** Absent when this daemon runs without a pairing token; the bridge then asks for none. */
  token?: string;
}

/**
 * The connect options a page is given when WE supply the connection rather than the app.
 *
 * One builder for both injection paths — this one, and re-pointing an SDK a hosted preview already
 * ships (`real-input.ts`) — so the two cannot come to disagree about what a daemon-driven page needs.
 */
export function injectedConnectArgs(opts: InjectedConnect): Record<string, unknown> {
  return {
    allowNonLocalhost: true,
    ...(opts.token === undefined ? {} : { token: opts.token }),
    url: opts.url,
  };
}

/**
 * The script for a page: install the SDK if the page has none, then connect it to this daemon.
 *
 * The guard is on the SINGLETON, not on a timer: a page that loaded its own SDK already holds
 * `__reticleInstance`, and evaluating a second copy would register a second session for one tab.
 * `connect` is a no-op once connected, so calling it on the page's own instance is safe.
 */
export function zeroInstallScript(bundle: string, opts: InjectedConnect): string {
  const args = JSON.stringify(injectedConnectArgs(opts));
  return `(() => {\nif (!globalThis.__reticleInstance) {\n${bundle}\n}\nglobalThis.__reticleInstance.connect(${args});\n})();`;
}

let cached: string | null | undefined;

/**
 * The single-file build, or undefined when this install has none.
 *
 * Read once and kept: it is ~450KB and identical for every lease. Absent means an older browser
 * package or a broken install, and the caller then behaves exactly as it did before this existed.
 */
export function readReaderBundle(): string | undefined {
  if (cached === undefined) {
    try {
      cached = readFileSync(createRequire(import.meta.url).resolve(READER_SPECIFIER), 'utf8');
    } catch {
      cached = null;
    }
  }
  return cached ?? undefined;
}
