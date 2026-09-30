/**
 * Moving a project that `init` already wired onto a different bridge port.
 *
 * Re-running `init --port 4689` over a project wired at 4688 used to be a silent no-op that
 * reported success: every step read "already", nothing was rewritten, setup started the daemon on
 * 4689, and the page kept dialling 4688 — "never dialled the bridge", with every file green. Each
 * of those files had an "exists → done" check that never looked at the port inside it.
 *
 * So the port is compared wherever `init` wrote one, and rewritten IN PLACE: the rest of each file
 * is the user's (registered stores, their own plugins), so only the number moves. With no `--port`
 * on the re-run there is nothing requested to converge on, and every file is left exactly as it is —
 * a re-run without the flag must not quietly reset a project to the default port.
 */

import {
  RETICLE_CLIENT_HOST,
  RETICLE_DEFAULT_PORT,
  RETICLE_WS_PATH,
  bridgeWsUrl,
} from '@reticlehq/core';
import { StepStatus, type Step } from './plan-types.js';

/** A rewritten source, and the port it was moved off (for the "port A → B" line). */
export interface Retargeted {
  code: string;
  from: number;
}

/** The bridge URL every generated connect bakes (`bridgeWsUrl`), with its port captured. */
const BRIDGE_URL = new RegExp(`(ws://${RETICLE_CLIENT_HOST}:)(\\d+)(${RETICLE_WS_PATH})\\b`, 'g');

/** The opening of the connect call every generated connect file makes. */
const CONNECT_CALL = 'reticle.connect({';

/** `port: <n>` inside the options object of a `reticle({ … })` plugin call. */
const PLUGIN_PORT = /(\breticle\(\s*\{[^}]*?\bport\s*:\s*)(\d+)/g;

/** The one line both rewrites print, so every file reports a move the same way. */
export function portMoveDetail(from: number, to: number): string {
  return `port ${String(from)} → ${String(to)}`;
}

/**
 * Rewrite every port `init` baked into a generated source file, or null when none differs.
 *
 * Covers the two shapes `init` writes: the bridge URL literal (Next's component, the SvelteKit hook,
 * the Nuxt plugin) and the plugin option (`reticle({ port })` in a Vite config). A Vite config with
 * a bare `reticle()` is null: the plugin reads the port from `.reticle.json`, which moves with it.
 */
export function retargetPort(source: string, to: number | undefined): Retargeted | null {
  if (to === undefined) return null;
  let from: number | undefined;
  let baked = false;
  /** True when this literal is the one to move; remembers the first port moved off. */
  const moves = (port: string): boolean => {
    baked = true;
    const current = Number(port);
    if (current === to) return false;
    from ??= current;
    return true;
  };
  const target = String(to);
  const code = source
    .replace(BRIDGE_URL, (match: string, head: string, port: string, tail: string) =>
      moves(port) ? `${head}${target}${tail}` : match,
    )
    .replace(PLUGIN_PORT, (match: string, head: string, port: string) =>
      moves(port) ? `${head}${target}` : match,
    );
  if (from !== undefined) return { code, from };
  // A port was baked and it is already the requested one: nothing to do. Falling through here used
  // to insert a SECOND `url:` beside the one already there on every same-port re-run —
  // `TS1117: An object literal cannot have multiple properties with the same name`, and the app's
  // build failed.
  if (baked) return null;
  // A default-port install bakes no URL at all — the SDK's default IS 4400 — so there is nothing to
  // rewrite, and the page would go on dialling 4400. Give the connect call the URL it now needs.
  if (RETICLE_DEFAULT_PORT === to || !source.includes(CONNECT_CALL)) return null;
  return {
    code: source.replace(CONNECT_CALL, `${CONNECT_CALL} url: '${bridgeWsUrl(to)}',`),
    from: RETICLE_DEFAULT_PORT,
  };
}

/**
 * The same, for `.reticle.json`: the `port` field set to the requested one, every other field kept.
 *
 * An absent `port` means the default, so moving onto the default REMOVES the field rather than
 * writing `4400` — the same shape a fresh install writes (see `reticleConfigContent`). Unreadable
 * JSON is null: `existingConfigProblem` already reports it, and rewriting a file we cannot parse
 * would drop whatever the user meant by it.
 */
export function retargetConfigPort(source: string, to: number | undefined): Retargeted | null {
  if (to === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if ('object' !== typeof parsed || null === parsed || Array.isArray(parsed)) return null;
  const fields = { ...(parsed as Record<string, unknown>) };
  const declared = fields['port'];
  const from = 'number' === typeof declared ? declared : RETICLE_DEFAULT_PORT;
  if (from === to) return null;
  if (RETICLE_DEFAULT_PORT === to) delete fields['port'];
  else fields['port'] = to;
  return { code: `${JSON.stringify(fields, null, 2)}\n`, from };
}

/**
 * The step for a file `init` already wrote, once a re-run's `--port` has been compared with it.
 *
 * Every "file exists" branch used to return ALREADY without reading the port inside the file; this is
 * the one place that turns the rewrite above into a step.
 */
export function alreadyOrMovedPort(
  already: Step,
  source: string | null | undefined,
  port: number | undefined,
): Step {
  if (StepStatus.ALREADY !== already.status) return already;
  if ('string' !== typeof source || port === undefined) return already;
  const moved = retargetPort(source, port);
  if (null === moved) return already;
  return {
    ...already,
    status: StepStatus.APPLY,
    detail: portMoveDetail(moved.from, port),
    write: { path: already.target, content: moved.code },
  };
}
