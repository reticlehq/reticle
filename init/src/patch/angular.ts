/**
 * Angular CLI: a dev-only connect in the browser entry, and a way for the pairing token to reach it.
 *
 * The connect is the part proven by hand on Angular 22, with and without SSR: a dynamic
 * `import('@reticlehq/browser')` guarded on `ngDevMode` (see DEV_GUARD for why not `isDevMode()`),
 * which the production build folds to `false` and drops together with the chunk it would load.
 *
 * The token is the hard part, and why this is not one line. The bridge refuses a hello without the
 * machine's pairing token even on localhost, and every other stack inlines it from Node at build
 * time — the Vite plugin's `define`, Next's `NEXT_PUBLIC_*`, CRA's gitignored `.env.development.local`.
 * The Angular CLI has no config file that runs code, so each of those has a failure here, all
 * measured on a scaffolded Angular 21 app before this was written:
 *
 * - A literal in `angular.json` (`define`, `fileReplacements`) commits a per-machine secret.
 * - A gitignored module imported from `main.ts` is bundled by `ng build` too: with the file present
 *   the production output held a lazy chunk carrying the token behind `isDevMode()`, which the
 *   build cannot fold — and a token must not depend on a guard being written exactly right.
 * - Making that module a dev-only `fileReplacements` target breaks `ng serve` for every teammate
 *   who has not run `init` ("path in file replacements does not exist").
 *
 * What is left is the serve target, which `ng build` never reads. Its `proxyConfig` is a JavaScript
 * module that `ng serve` loads in Node, so `reticle.proxy.mjs` reads `~/.reticle/pairing-token` at
 * request time — the same file the Vite and Next plugins read — and answers one same-origin route
 * with it. The token is never written into the project, and a production build has no route to it.
 */

import { connectArg } from './snippets.js';
import { PatchKind, type SourcePatch } from './patch-kind.js';

/** The generated dev-server module, beside `angular.json`. */
export const ANGULAR_PROXY_PATH = 'reticle.proxy.mjs';
/** The one route that module answers, fetched by the entry's dev-only connect. */
export const ANGULAR_TOKEN_PATH = '/__reticle/pairing-token';
/** What an Angular CLI app's browser entry is when `angular.json` does not say. */
export const ANGULAR_DEFAULT_ENTRY = 'src/main.ts';

const SENSOR = '@reticlehq/browser';
const DEV_SERVER_BUILDER = /:dev-server$/;

const UNPARSEABLE_REASON = 'angular.json is not plain JSON, so it is not safe to rewrite by hand';
const NO_SERVE_TARGET_REASON =
  'no project in angular.json has a `serve` target on a dev-server builder, so there is nowhere ' +
  'for `ng serve` to pick up the token route';
const SEVERAL_APPS_REASON =
  'angular.json has several projects with a `serve` target, and which one is the app is not ours ' +
  'to guess';

/** An `angular.json` project's targets, under either spelling the CLI accepts. */
interface TargetsHost {
  architect?: Record<string, Target>;
  targets?: Record<string, Target>;
}
interface Target {
  builder?: string;
  options?: Record<string, unknown>;
}

interface Workspace {
  /** The whole parsed file, so a patch rewrites everything it did not touch exactly as it was. */
  readonly root: Record<string, unknown>;
  readonly projects: Record<string, TargetsHost>;
}

function parseWorkspace(source: string): Workspace | undefined {
  try {
    const parsed: unknown = JSON.parse(source);
    if ('object' !== typeof parsed || null === parsed) return undefined;
    const root = parsed as Record<string, unknown>;
    const projects = root['projects'];
    if ('object' !== typeof projects || null === projects) return undefined;
    return { root, projects: projects as Record<string, TargetsHost> };
  } catch {
    return undefined;
  }
}

function targetsOf(project: TargetsHost): Record<string, Target> {
  return project.architect ?? project.targets ?? {};
}

/** The projects `ng serve` can serve — the only ones with a page to connect. */
function servedProjects(projects: Record<string, TargetsHost>): TargetsHost[] {
  return Object.values(projects).filter((p) =>
    DEV_SERVER_BUILDER.test(targetsOf(p)['serve']?.builder ?? ''),
  );
}

/**
 * The browser entry `angular.json` names — `browser` on the application builder (v17+), `main` on
 * the webpack one — or the CLI's default when it cannot be read.
 */
export function angularEntry(source: string | null): string {
  const workspace = null === source ? undefined : parseWorkspace(source);
  const [only, ...rest] = workspace === undefined ? [] : servedProjects(workspace.projects);
  if (only === undefined || rest.length > 0) return ANGULAR_DEFAULT_ENTRY;
  const options = targetsOf(only)['build']?.options ?? {};
  const named = options['browser'] ?? options['main'];
  return 'string' === typeof named && named.length > 0 ? named : ANGULAR_DEFAULT_ENTRY;
}

/**
 * Point the one app's serve target at `reticle.proxy.mjs`.
 *
 * An existing `proxyConfig` is the app's, and is never replaced: the step goes MANUAL naming the
 * entry to add to it. The file is rewritten through `JSON.stringify` with the CLI's own two-space
 * indent, which is how `ng new` writes it, so the diff is the one key.
 */
export function patchAngularJson(source: string): SourcePatch {
  const workspace = parseWorkspace(source);
  if (workspace === undefined) return { kind: PatchKind.MANUAL, reason: UNPARSEABLE_REASON };
  const served = servedProjects(workspace.projects);
  const [only, ...rest] = served;
  if (only === undefined) return { kind: PatchKind.MANUAL, reason: NO_SERVE_TARGET_REASON };
  if (rest.length > 0) return { kind: PatchKind.MANUAL, reason: SEVERAL_APPS_REASON };
  const serve = targetsOf(only)['serve'];
  if (serve === undefined) return { kind: PatchKind.MANUAL, reason: NO_SERVE_TARGET_REASON };
  const existing = serve.options?.['proxyConfig'];
  if (ANGULAR_PROXY_PATH === existing) return { kind: PatchKind.ALREADY };
  if (existing !== undefined) {
    return {
      kind: PatchKind.MANUAL,
      reason:
        `the serve target already uses ${JSON.stringify(existing)} as its proxyConfig, and it is yours — ` +
        `add the \`${ANGULAR_TOKEN_PATH}\` entry from ${ANGULAR_PROXY_PATH} to it`,
    };
  }
  serve.options = { ...serve.options, proxyConfig: ANGULAR_PROXY_PATH };
  return { kind: PatchKind.APPLY, code: `${JSON.stringify(workspace.root, null, 2)}\n` };
}

/**
 * The dev-server module. Plain ESM, no dependencies, because it runs in the app's `ng serve`.
 *
 * Two refusals, both about who may read a token: a request that did not come over loopback (an
 * `ng serve --host 0.0.0.0` on a shared network), and a browser request from another origin — a
 * different localhost app — which `Sec-Fetch-Site` names on every current browser.
 *
 * `bypass` answers the request itself and returns `false`, so the dummy `target` is never dialled.
 * ponytail: relies on the Vite-based dev server (Angular 17+) ignoring the 404 it sets after the
 * response has already ended; the older webpack dev server calls `next()` instead, and if it ever
 * matters there the upgrade is a `configure` hook instead of `bypass`.
 */
export function angularProxyFile(): string {
  return `// Written by \`reticle init\`. Read by \`ng serve\` only — \`ng build\` never loads a proxy config.
//
// Hands the page this machine's Reticle pairing token, read at request time from the file the
// Reticle daemon keeps (~/.reticle/pairing-token). The token is per-machine and never written into
// this project, so nothing here needs to be kept out of version control.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function pairingToken() {
  const dir = process.env.RETICLE_PAIRING_TOKEN_DIR || join(homedir(), '.reticle');
  try {
    return readFileSync(join(dir, 'pairing-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

export default {
  '${ANGULAR_TOKEN_PATH}': {
    target: 'http://127.0.0.1:9',
    bypass(req, res) {
      const site = req.headers['sec-fetch-site'];
      const allowed =
        LOOPBACK.has(req.socket.remoteAddress ?? '') && (site === undefined || site === 'same-origin');
      res.writeHead(allowed ? 200 : 403, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end(allowed ? pairingToken() : '');
      return false;
    },
  },
};
`;
}

/** Everything `connect()` is called with, as the literal's inner fields — `url` only off 4400. */
function connectFields(port: number | undefined, projectId: string | undefined): string {
  const literal = connectArg(port, projectId);
  return literal.length > 0 ? `${literal.slice(1, -1).trim()}, ` : '';
}

/**
 * The guard the connect sits under: Angular's own `ngDevMode` global, not `isDevMode()`.
 *
 * `isDevMode()` is a runtime call, so `ng build` cannot fold it: the production bundle shipped the
 * whole connect — the bridge URL included — plus ~300KB of lazy Reticle chunks that nothing
 * would ever load. The Angular CLI defines `ngDevMode` to `false` in a production build, which lets
 * esbuild drop the branch and, with it, the dynamic import; in dev it is undefined or an object, so
 * this reads exactly as `isDevMode()` did there. It is the check Angular's own sources use.
 */
const DEV_GUARD = "if (typeof ngDevMode === 'undefined' || ngDevMode) {";
/** Declared locally so strict TypeScript accepts the global without the app importing anything. */
const NG_DEV_MODE_DECLARATION = 'declare const ngDevMode: unknown;';
/** The guard the previous version wrote, which is rewritten in place on a re-run. */
const LEGACY_GUARD =
  /^if \(isDevMode\(\)\) \{(?=\s*void Promise\.all\(\[\s*import\('@reticlehq\/browser'\))/m;
/** The comment the previous version wrote above it, which named the guard it no longer uses. */
const LEGACY_COMMENT =
  /^\/\/ Reticle, dev only — written by `reticle init`\. `isDevMode\(\)` is false in a production build,\n\/\/ so this never runs there\./m;
const HEADER =
  '// Reticle, dev only — written by `reticle init`. `ngDevMode` is false in a production build,\n' +
  '// so the build drops this block.';

/**
 * Add the dev-only connect to the browser entry, or ALREADY when it is there.
 *
 * Appended after the bootstrap rather than before it: the app must never wait on Reticle, and a
 * connect that fails (no daemon yet) must not be able to stop Angular from starting.
 *
 * An entry wired by the previous version (`if (isDevMode())`) is rewritten in place, so a re-run is
 * what takes the connect out of an existing app's production bundle.
 */
export function patchAngularMain(
  source: string,
  port: number | undefined,
  projectId: string | undefined,
): SourcePatch {
  if (LEGACY_GUARD.test(source)) {
    const guarded = source
      .replace(LEGACY_COMMENT, HEADER)
      .replace(LEGACY_GUARD, `${NG_DEV_MODE_DECLARATION}\n${DEV_GUARD}`);
    return { kind: PatchKind.APPLY, code: guarded };
  }
  if (source.includes(SENSOR)) return { kind: PatchKind.ALREADY };
  const declaration = source.includes(NG_DEV_MODE_DECLARATION)
    ? ''
    : `${NG_DEV_MODE_DECLARATION}\n`;
  const block = `
${HEADER} The pairing token comes from \`ng serve\` (${ANGULAR_PROXY_PATH}), so it
// is never in a source file or a bundle.
${declaration}${DEV_GUARD}
  void Promise.all([
    import('${SENSOR}'),
    fetch('${ANGULAR_TOKEN_PATH}')
      .then((res) => (res.ok ? res.text() : ''))
      .catch(() => ''),
  ]).then(([{ reticle }, token]) => {
    reticle.connect({ ${connectFields(port, projectId)}...(token ? { token } : {}) });
  });
}
`;
  return { kind: PatchKind.APPLY, code: `${source.trimEnd()}\n${block}` };
}
