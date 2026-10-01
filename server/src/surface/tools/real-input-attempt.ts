/**
 * The native-input attempt — everything that decides whether a pointer action is driven through a
 * real input provider or falls back to the occlusion-honest synthetic path, and WHY.
 *
 * Split out of act-tools.ts along its natural seam: the act tools care only about the outcome
 * (`result` defined = it went native), never about provider availability, box resolution,
 * drag-target inspection or the reason taxonomy.
 *
 * Also hosts `rewriteUploadArgs` — the daemon-side path that lets an agent name a file on disk
 * and have its REAL bytes reach the browser's `<input type="file">`. The browser SDK cannot read
 * the filesystem; the daemon can. The rewrite happens here, before the ACT command crosses the
 * bridge, so the browser side sees a normal `{ content, name, type }` call and `assertUploadArgs`
 * keeps its invariant (no fabricated bytes, no silently-dropped keys).
 *
 * Trust boundary: scoped to the project root (one level above `deps.reticleRoot`) plus any
 * opt-in `uploadRoots` declared in `.reticle.json`, resolved through `realpath` so symlinks
 * cannot escape an allowed root. Sensitive files (.env*, .git/, *.pem, id_*, .npmrc) are denied
 * with a message that says why. The cap is derived from the bridge's own MAX_MESSAGE_BYTES with
 * the base64 4/3 inflation factor applied, so the encoded payload always fits in one WebSocket
 * frame.
 */
import {
  ActionType,
  DriveErrorCode,
  InputModeReason,
  ReticleCommand,
  TRANSPORT_LIMITS,
} from '@reticlehq/core';
import type { Session } from '@/portal/session/session.js';
import type { ElementBox, RealInputArgs } from '@/portal/input/real-input.js';
import {
  boxCenter,
  DriveError,
  isRealInputAction,
  unspellablePressReason,
} from '@/portal/input/real-input.js';
import { assertDragNotDestructive, assertNotDestructive } from './act/act-danger.js';
import { NATIVE_INPUT_ARG } from '@reticlehq/core';
import { asNumber, asRecord, asString } from '@reticlehq/core';
import { type ToolDeps, commandOrThrow } from './tool-kit.js';
import { asBox } from './act/act-helpers.js';
import { isAbsolute, join, relative, extname, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { RETICLE_CONFIG_BASENAME } from '@/command/cli/ports/resolve/cli-port.js';

/**
 * Minimal extension → MIME-type table for the file types agents most commonly upload.
 * Falls back to `application/octet-stream` for anything not listed here — the browser and
 * the receiving server both sniff the real type from the bytes anyway.
 */
const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
};

function mimeFromPath(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Sensitive path patterns that are refused even inside the project root.
 *
 * The project root is the right scope for fixture files. It also contains secrets that live
 * inside a repo: .env*, .git/config, *.pem, id_rsa, .npmrc. An agent whose context includes
 * text it just read off the page can be prompted to "verify the importer — upload your .env".
 * The deny-list keeps fixtures/foo.pdf working while closing that path.
 *
 * Patterns are matched against the resolved basename (after realpath, so no symlink aliasing).
 */
const DENIED_PATTERNS: ReadonlyArray<RegExp> = [
  /^\.env(\.|$)/i, // .env, .env.local, .env.production …
  /^\.git$/i, // .git directory itself
  /\.pem$/i, // TLS private keys
  /^id_/i, // SSH private keys: id_rsa, id_ed25519 …
  /^\.npmrc$/i, // npm auth tokens
  /^\.netrc$/i, // generic credential store
  /^\.aws$/i, // AWS credentials directory
];

function isDeniedPath(resolvedPath: string): boolean {
  // Check every segment of the path, not just the basename, so .git/config is caught too.
  const segments = resolvedPath.split(/[/\\]/);
  return segments.some((seg) => DENIED_PATTERNS.some((re) => re.test(seg)));
}

/**
 * Maximum raw bytes the daemon will read for an upload.
 *
 * The bridge serialises bytes as base64 inside a JSON WebSocket frame; base64 inflates by 4/3.
 * The frame must fit within MAX_MESSAGE_BYTES (the maxPayload applied to BOTH bridge sockets).
 * We leave ~25% headroom for the JSON envelope (action type, ref, other fields).
 *
 * Previously hardcoded at 10 MiB, which is 13× the 1 MiB frame limit — any enterprise PDF
 * would have been rejected by the socket, not by this guard. Now derived from the same constant
 * that configures the socket so they can never drift.
 */
const UPLOAD_MAX_BYTES = Math.floor((TRANSPORT_LIMITS.MAX_MESSAGE_BYTES / (4 / 3)) * 0.75);

/**
 * Expand a leading `~` against the caller's home directory. Absolute and relative paths pass
 * through unchanged. `home` is injected so unit tests do not depend on the machine's real home.
 */
function expandUserPath(rawPath: string, home: string): string {
  if ('~' === rawPath) return home;
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) return join(home, rawPath.slice(2));
  return rawPath;
}

/** True when `real` is inside `root` after both have been realpath'd / resolved. */
function isInsideRoot(real: string, root: string): boolean {
  const rel = relative(root, real);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Opt-in extra upload directories from `.reticle.json` (`uploadRoots`). Absent, empty, or unreadable
 * config means project-root only — the previous default, kept on purpose.
 */
async function readUploadRoots(
  projectRoot: string,
  fs: ToolDeps['fs'],
  home: string,
): Promise<readonly string[]> {
  const configPath = join(projectRoot, RETICLE_CONFIG_BASENAME);
  let raw: string;
  try {
    raw = await fs.readFile(configPath);
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if ('object' !== typeof parsed || null === parsed || Array.isArray(parsed)) return [];
  const listed = (parsed as Record<string, unknown>)['uploadRoots'];
  if (!Array.isArray(listed)) return [];
  const roots: string[] = [];
  for (const entry of listed) {
    if ('string' !== typeof entry || 0 === entry.trim().length) continue;
    roots.push(resolve(expandUserPath(entry.trim(), home)));
  }
  return roots;
}

/**
 * Resolve and validate a caller-supplied upload path.
 *
 * 1. Expand a leading `~`, then resolve to absolute (join against project root for relative paths).
 * 2. Call `realpath` to follow symlinks — `relative()` is lexical and a symlink inside the tree
 *    can point outside it; realpath is the only reliable check.
 * 3. Confirm the real path is within the project root or an opt-in `uploadRoots` entry.
 * 4. Confirm the path does not match the sensitive-file deny-list.
 *
 * Returns the resolved real path on success. Throws with a user-readable message on any violation.
 */
async function resolveUploadPath(
  rawPath: string,
  projectRoot: string,
  fs: ToolDeps['fs'],
  uploadRoots: readonly string[],
  home: string,
): Promise<string> {
  const expanded = expandUserPath(rawPath, home);
  const abs = isAbsolute(expanded) ? expanded : join(projectRoot, expanded);

  // realpath resolves symlinks; it also rejects ENOENT, so we get a clear missing-file error.
  const real = await fs.realpath(abs).catch(() => {
    throw new Error(
      `upload path '${rawPath}' could not be read: file not found or not accessible.`,
    );
  });

  const allowed = [projectRoot, ...uploadRoots];
  if (!allowed.some((root) => isInsideRoot(real, root))) {
    const listed = allowed.map((r) => `'${r}'`).join(', ');
    throw new Error(
      `upload path '${rawPath}' resolves to '${real}', which is outside every allowed upload root ` +
        `(${listed}). Paths must sit under the project directory or an entry in ` +
        `\`.reticle.json\`'s \`uploadRoots\` (e.g. ["~/Downloads"]).`,
    );
  }

  if (isDeniedPath(real)) {
    throw new Error(
      `upload path '${rawPath}' matches a sensitive-file pattern and cannot be read by the daemon. ` +
        'Fixture files for upload tests should live in a dedicated directory (e.g. fixtures/).',
    );
  }

  return real;
}

/**
 * If the action is `upload` AND the inner args carry `path`, read the file from disk and rewrite
 * the args to `{ content, name, type, __base64: true }` before the ACT command reaches the browser.
 *
 * Returns the (possibly rewritten) args object. All other actions are returned unchanged.
 *
 * This is the SINGLE interception point — called from session.command() so flow replay, crawl,
 * and every other ACT dispatch site are covered without per-site wiring.
 */
export async function rewriteUploadArgs(
  deps: Pick<ToolDeps, 'fs' | 'reticleRoot'>,
  action: string,
  innerArgs: Record<string, unknown>,
  /** Injected for tests; production uses the process home directory. */
  home: string = homedir(),
): Promise<Record<string, unknown>> {
  if (action !== ActionType.UPLOAD) return innerArgs;
  const rawPath = asString(innerArgs['path']);
  if (rawPath === undefined) return innerArgs; // no path → browser handles as inline upload

  // Project root is one level above .reticle/
  const projectRoot = resolve(join(deps.reticleRoot, '..'));
  const uploadRoots = await readUploadRoots(projectRoot, deps.fs, home);

  // Blocker 4 fix: stat FIRST, before allocating read buffer, so a huge file fails fast.
  const realPath = await resolveUploadPath(rawPath, projectRoot, deps.fs, uploadRoots, home);
  const fileStat = await deps.fs.stat(realPath).catch(() => {
    throw new Error(
      `upload path '${rawPath}' could not be read: file not found or not accessible.`,
    );
  });

  // Blocker 2 fix: cap is now derived from TRANSPORT_LIMITS so it can never exceed the socket limit.
  if (fileStat.size > UPLOAD_MAX_BYTES) {
    throw new Error(
      `upload path '${rawPath}' is ${fileStat.size} bytes, which exceeds the ` +
        `${UPLOAD_MAX_BYTES} byte upload limit (bridge frame cap). ` +
        'Split the file or pass its bytes as args.content directly.',
    );
  }

  const bytes = await deps.fs.readFileBytes(realPath).catch(() => {
    throw new Error(
      `upload path '${rawPath}' could not be read: file not found or not accessible.`,
    );
  });

  // Encode as base-64 so the bytes survive JSON serialisation across the bridge.
  const content = Buffer.from(bytes).toString('base64');

  // Infer MIME type from the file extension; fall back to octet-stream if unknown.
  const callerType = asString(innerArgs['type']);
  const type = callerType ?? mimeFromPath(realPath);

  // Default filename to the basename of the REAL path (post-symlink-resolution).
  const callerName = asString(innerArgs['name']);
  const name = callerName ?? basename(realPath);

  // Strip 'path' — the browser does not know it; assertUploadArgs would refuse it.
  // __base64: true tells the browser-side dispatch to decode content before File construction.
  const { path: _dropped, name: _n, type: _t, ...rest } = innerArgs;
  return { ...rest, content, name, type, __base64: true };
}

interface RealActResult {
  /** Defined only on a successful native action; `undefined` means the synthetic path runs. */
  result: unknown;
  settled: boolean;
  /** Set when a provider was available but threw — surfaces the fallback to the agent. */
  fellBack?: boolean;
  /** Why we went synthetic despite a configured provider (field bug #2: never a silent fallback). */
  reason?: InputModeReason;
}

/** Synthetic outcome with a diagnostic reason (provider configured but native input skipped). */
function synthetic(reason?: InputModeReason): RealActResult {
  return reason === undefined
    ? { result: undefined, settled: false }
    : { result: undefined, settled: false, reason };
}

/**
 * Filler for the provider signature, which demands a box on every action.
 *
 * No coordinate is derived from it and none is reported back: `performGesture` returns before it
 * reads the box on a press, because a key addresses focus rather than a point.
 */
const PRESS_HAS_NO_BOX: ElementBox = { x: 0, y: 0, width: 0, height: 0 };

/**
 * Hover without a native pointer is a false success: synthetic mouseover reports dispatched and
 * settled while CSS `:hover` never applies. Same refusal shape as contenteditable — name the gap
 * rather than pretend the action ran.
 */
export const HOVER_NEEDS_POINTER_MSG =
  'cannot hover without a real pointer — CSS :hover only applies to a native mouse move, never to a synthetic mouseover';

function hoverSucceeded(center: { cx: number; cy: number }): RealActResult {
  return { result: { performed: true, center, action: ActionType.HOVER }, settled: true };
}

/**
 * Drive hover through a real pointer (CDP provider, then a leased Playwright page), or refuse.
 *
 * A leased tab already owns Chromium — the pool can move the mouse even when `reticle drive` /
 * `RETICLE_CDP_URL` never configured a provider. Falling through to synthetic dispatch is the
 * bug: the tool reports done and the styles never ran.
 */
async function hoverForReal(
  deps: ToolDeps,
  session: Session,
  ref: string,
  inner: Record<string, unknown>,
  provider: ToolDeps['realInput'],
): Promise<RealActResult> {
  const providerReady = provider !== undefined && (await provider.isAvailableFor(session.url));
  if (!providerReady && deps.pool === undefined) {
    throw new Error(HOVER_NEEDS_POINTER_MSG);
  }

  const inspected = await commandOrThrow(deps, session.id, ReticleCommand.INSPECT, { ref });
  assertNotDestructive(ActionType.HOVER, inner, inspected);
  const box = asBox(inspected);
  if (box === undefined) {
    throw new Error(HOVER_NEEDS_POINTER_MSG);
  }

  if (providerReady && provider !== undefined) {
    try {
      const performed = await provider.perform(session.url, ActionType.HOVER, box, {});
      // Hover always has a resolved box, so there is always a center to report: the provider's own
      // reading, or the box's if it reported none. Both are the same point, not a fabricated one.
      if (performed.performed) return hoverSucceeded(performed.center ?? boxCenter(box));
    } catch {
      // A provider error used to fall back to synthetic dispatch. For hover that is a lie.
    }
  }

  const { cx, cy } = boxCenter(box);
  if (true === (await deps.pool?.hoverLease(session.id, cx, cy))) {
    return hoverSucceeded({ cx, cy });
  }

  throw new Error(HOVER_NEEDS_POINTER_MSG);
}

/**
 * Attempt to drive a pointer action via native input. Returns a synthetic outcome (with a
 * `reason` when a provider is configured) whenever the synthetic path should run — no matching
 * page, unresolvable box, declined, etc. A throw inside the provider becomes a synthetic fallback
 * flagged with `fellBack`. `result` is defined only on a real success.
 *
 * Hover is the exception: it never returns synthetic. CSS `:hover` is not applied by
 * `dispatchEvent`, so a synthetic success is the defect. The call either drives a real pointer
 * or throws.
 */
export async function tryRealInput(
  deps: ToolDeps,
  session: Session,
  ref: string,
  action: ActionType,
  args: Record<string, unknown>,
): Promise<RealActResult> {
  const provider = deps.realInput;
  const inner = asRecord(args['args']);
  const askedForNative = true === inner[NATIVE_INPUT_ARG];
  if (action === ActionType.HOVER) {
    return hoverForReal(deps, session, ref, inner, provider);
  }
  if (provider === undefined) {
    // Silent by default: with no provider EVERY action is synthetic, and a reason on all of them is
    // noise on the most-used tool in the product. But an agent that passed native:true asked a
    // question and got the opposite answer — reported from the field as a silent downgrade that cost
    // real debugging time, because the tool description promises a reason is "never silent".
    return askedForNative ? synthetic(InputModeReason.NOT_CONFIGURED) : synthetic();
  }
  // Two `press`es this module will NOT drive, and neither is a fallback — the reason says which
  // one was asked for, instead of a different gesture being sent. See `unspellablePressReason`.
  if (action === ActionType.PRESS) {
    const unspellable = unspellablePressReason(ref, inner);
    if (unspellable !== undefined) return synthetic(unspellable);
  }

  if (!isRealInputAction(action)) return synthetic(InputModeReason.NOT_POINTER); // fill/type stay synthetic

  // "Don't click, run the code": a click/dblclick runs the occlusion-honest SYNTHETIC path by default
  // even with a provider configured — no coordinate gesture to be intercepted by the HUD or missed
  // off-screen. Opt into a trusted native click with args.native:true (file pickers, clipboard,
  // isTrusted-gated handlers). hover/drag genuinely need native pointer state, so they stay real.
  if ((action === ActionType.CLICK || action === ActionType.DBLCLICK) && !askedForNative) {
    return synthetic(InputModeReason.SYNTHETIC_CLICK_PREFERRED);
  }

  // Under version skew CDP is unusable while DOM tools still work (#688). Surface the skew sentence
  // rather than "page not correlated" / a silent provider-error fallback — those send the agent
  // hunting a dead context that is not dead.
  //
  // `press` is exempt, and it is the one action where throwing would take something away: a
  // document key is dispatched entirely in the page, so it does not need CDP at all and has always
  // worked under skew. Routing it into real input made it reach this line for the first time, and
  // throwing here would turn a working synthetic press into a hard failure. It falls through to
  // `isAvailableFor` instead, and a driver that really is dead answers PROVIDER_ERROR with the
  // usual `fellBack` — still a signal, just not a refusal.
  if (action !== ActionType.PRESS && session.versionSkew !== undefined) {
    throw new Error(session.versionSkew);
  }

  if (!(await provider.isAvailableFor(session.url)))
    return synthetic(InputModeReason.PAGE_NOT_CORRELATED);

  const performArgs: RealInputArgs = {};
  const value = asString(inner['value']);
  if (value !== undefined) performArgs.value = value;
  const text = asString(inner['text']);
  if (text !== undefined) performArgs.text = text;
  const key = asString(inner['key']);
  if (key !== undefined) performArgs.key = key;
  const modifiers = inner['modifiers'];
  if (Array.isArray(modifiers)) {
    performArgs.modifiers = modifiers.filter((m): m is string => 'string' === typeof m);
  }
  // A held key is the whole point of a hold-to-confirm control, and the synthetic path has honoured
  // `holdMs` all along. Not forwarding it made the real keyboard the WEAKER of the two paths: it
  // drove the key instantly and reported a hold that never held.
  const holdMs = asNumber(inner['holdMs']);
  if (holdMs !== undefined) performArgs.holdMs = holdMs;
  // `keys` and `code` are read but not forwarded: both are routed away above — a multi-key sequence
  // and an explicit physical code have no driver spelling — so carrying them into the provider would
  // only invite it to guess at a gesture the caller did not ask for.

  // A document key has no element of its own: skip INSPECT and the box entirely.
  if (action === ActionType.PRESS) {
    try {
      const performed = await provider.perform(session.url, action, PRESS_HAS_NO_BOX, performArgs);
      if (!performed.performed) return synthetic(InputModeReason.PROVIDER_DECLINED);
      // No `center`: a key addresses focus, not a point. The placeholder's zero happened nowhere.
      //
      // `heldMs` IS forwarded, and it is the whole reason this object is not just the three fields
      // above: `reticle_act`'s description promises `effect.heldMs` reports the hold actually
      // achieved, and on the real path the act result IS the `effect` block. Dropping it here made
      // that promise true on the synthetic path and silently false on the one this release added
      // `holdMs` to — an agent checking for an armed hold-to-confirm control read `undefined`.
      return {
        result: {
          performed: true,
          action,
          inputMode: performed.inputMode,
          ...(performed.heldMs !== undefined ? { heldMs: performed.heldMs } : {}),
        },
        settled: true,
      };
    } catch (error) {
      // The ONE failure that must not fall back. Every other throw means the gesture did not
      // happen, and the synthetic path is the honest answer. A release that failed means the
      // gesture DID happen and the key may still be down — replaying it synthetically presses the
      // same key a second time on top of a keyboard that is already holding something, which is
      // the corruption the release exists to prevent. Refusing is the only answer that cannot
      // make it worse.
      if (error instanceof DriveError && error.code === DriveErrorCode.RELEASE_FAILED) {
        throw error;
      }
      // No skew re-throw here, unlike the pointer path below: this action has a working synthetic
      // route (see the skew check above), so the honest answer to a driver that threw is the
      // fallback, not a refusal.
      return {
        result: undefined,
        settled: false,
        fellBack: true,
        reason: InputModeReason.PROVIDER_ERROR,
      };
    }
  }

  const inspected = await commandOrThrow(deps, session.id, ReticleCommand.INSPECT, { ref });
  assertNotDestructive(action, inner, inspected);
  const box = asBox(inspected);
  if (box === undefined) return synthetic(InputModeReason.ELEMENT_NOT_LOCATABLE);

  let toBox: ElementBox | undefined;
  if (action === ActionType.DRAG) {
    const toRef = asString(inner['toRef']);
    if (toRef === undefined) return synthetic(InputModeReason.DRAG_TARGET_UNRESOLVED);
    const targetInspected = await commandOrThrow(deps, session.id, ReticleCommand.INSPECT, {
      ref: toRef,
    });
    // A drag is judged on BOTH ends: dropping onto "Trash" is destructive however innocent the
    // thing being dragged looks.
    assertDragNotDestructive(inner, inspected, targetInspected);
    toBox = asBox(targetInspected);
    if (toBox === undefined) return synthetic(InputModeReason.DRAG_TARGET_UNRESOLVED);
  }

  if (toBox !== undefined) performArgs.toBox = toBox;

  try {
    const performed = await provider.perform(session.url, action, box, performArgs);
    if (!performed.performed) return synthetic(InputModeReason.PROVIDER_DECLINED);
    return { result: { performed: true, center: performed.center, action }, settled: true };
  } catch {
    if (session.versionSkew !== undefined) throw new Error(session.versionSkew);
    return {
      result: undefined,
      settled: false,
      fellBack: true,
      reason: InputModeReason.PROVIDER_ERROR,
    };
  }
}
