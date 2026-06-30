import { transformSync } from '@babel/core';
import reticleSource from '@reticlehq/babel-plugin';
import { RETICLE_DEFAULT_PORT, RETICLE_WS_PATH } from '@reticlehq/protocol';
import { resolveProjectId } from './project-id.js';

export const RETICLE_VITE_PLUGIN_NAME = 'reticle';

/** The one-install package the host app imports the SDK from. */
const RETICLE_PACKAGE = '@reticlehq/core';
/** Files we stamp with source info — JSX/TSX only. */
const JSX_FILE = /\.[jt]sx$/;
/** Rollup virtual-module ids start with a NUL byte; never transform those. */
const VIRTUAL_PREFIX = '\0';
const NODE_MODULES = 'node_modules';

/**
 * The connect code is served as a real module (not an inline <script>) so that Vite's import
 * pipeline resolves the bare `@reticlehq/core` specifier. An inline injected script is NOT run through
 * import resolution, so its bare import would fail in the browser. This path-like id is requested
 * by the injected <script src> and served by the load() hook below.
 */
export const RETICLE_CONNECT_MODULE = '/@reticle-connect';

export interface ReticleVitePluginOptions {
  /** Bridge WebSocket port. Defaults to the SDK default; only baked into connect() when non-default. */
  port?: number;
  /** Stable session label for the bridge. Defaults to the SDK's auto-generated id. */
  session?: string;
  /**
   * Stable project identity. Defaults to one derived from the app's package.json name + root path,
   * so multi-project session scoping works with zero config. Override only for special setups.
   */
  projectId?: string;
  /** Auth token forwarded to connect() when the bridge requires one. */
  token?: string;
  /** Stamp data-reticle-source for React 19 source mapping. Default true (harmless on React <=18). */
  sourceMapping?: boolean;
  /** Auto-inject the dev-gated reticle.connect() call. Default true. */
  inject?: boolean;
}

/** Structural Vite plugin shape — avoids a hard dependency on `vite` while staying assignable to its `Plugin`. */
export interface ReticleVitePlugin {
  name: string;
  apply: 'serve';
  enforce: 'pre';
  transform: (code: string, id: string) => { code: string; map: string | null } | null;
  resolveId: (id: string) => string | null;
  load: (id: string) => string | null;
  transformIndexHtml: (html: string) => HtmlTag[];
}

interface HtmlTag {
  tag: string;
  attrs: Record<string, string>;
  injectTo: 'body';
}

function shouldStamp(id: string): boolean {
  if (id.startsWith(VIRTUAL_PREFIX)) return false;
  if (id.includes(NODE_MODULES)) return false;
  // Strip any query suffix (?worker, ?raw, ...) before matching the extension.
  const clean = id.split('?')[0] ?? id;
  return JSX_FILE.test(clean);
}

function stamp(code: string, id: string): { code: string; map: string | null } | null {
  const out = transformSync(code, {
    filename: id,
    plugins: [reticleSource],
    parserOpts: { plugins: ['jsx', 'typescript'] },
    sourceMaps: true,
    configFile: false,
    babelrc: false,
  });
  if (out?.code === undefined || out.code === null) return null;
  return {
    code: out.code,
    map: out.map === undefined || out.map === null ? null : JSON.stringify(out.map),
  };
}

/** Build the `reticle.connect()` argument literal — only includes keys the user set. */
function connectArgs(options: ReticleVitePluginOptions): string {
  const args: Record<string, string | number> = {};
  const port = options.port ?? RETICLE_DEFAULT_PORT;
  if (port !== RETICLE_DEFAULT_PORT)
    args['url'] = `ws://localhost:${String(port)}${RETICLE_WS_PATH}`;
  if (options.session !== undefined) args['session'] = options.session;
  if (options.projectId !== undefined) args['projectId'] = options.projectId;
  if (options.token !== undefined) args['token'] = options.token;
  return Object.keys(args).length > 0 ? JSON.stringify(args) : '';
}

/** The body of the connect module — real imports, resolved by Vite when the module is served. */
export function connectModuleSource(options: ReticleVitePluginOptions): string {
  const args = connectArgs(options);
  return `import { reticle, install } from '${RETICLE_PACKAGE}';\ninstall();\nreticle.connect(${args});\n`;
}

/**
 * Reticle Vite plugin. Add to your `plugins` array and the entire integration is done:
 *
 *   import { reticle } from '@reticlehq/core/vite';
 *   export default defineConfig({ plugins: [react(), reticle()] });
 *
 * `apply: 'serve'` means Vite drops the plugin entirely from `vite build` — production bundles
 * are never instrumented. Gating is the tool's job, not a user-managed env check.
 */
export function reticle(options: ReticleVitePluginOptions = {}): ReticleVitePlugin {
  const sourceMapping = options.sourceMapping !== false;
  const inject = options.inject !== false;
  // Resolve the stable projectId once (explicit option, else derived from package.json + cwd) so the
  // app is identifiable across port changes with zero config.
  const resolved: ReticleVitePluginOptions = {
    ...options,
    projectId: resolveProjectId(options.projectId, process.cwd()),
  };
  return {
    name: RETICLE_VITE_PLUGIN_NAME,
    apply: 'serve',
    enforce: 'pre',
    transform(code, id) {
      if (!sourceMapping || !shouldStamp(id)) return null;
      return stamp(code, id);
    },
    resolveId(id) {
      // Return the id verbatim so Vite serves it back to load() (the bare imports inside it then
      // go through normal resolution). No NUL prefix: the browser requests it as a URL.
      return inject && id === RETICLE_CONNECT_MODULE ? RETICLE_CONNECT_MODULE : null;
    },
    load(id) {
      return inject && id === RETICLE_CONNECT_MODULE ? connectModuleSource(resolved) : null;
    },
    transformIndexHtml() {
      if (!inject) return [];
      return [
        { tag: 'script', attrs: { type: 'module', src: RETICLE_CONNECT_MODULE }, injectTo: 'body' },
      ];
    },
  };
}
