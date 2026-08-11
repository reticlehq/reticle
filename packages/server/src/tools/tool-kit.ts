/**
 * Shared kit for the MCP tool modules — the tool shape, the dependency bag, the common
 * session-id arg, and the two helpers (commandOrThrow, snapshotTree) every tool group needs. Lives
 * in its own leaf module (no dependency on any tool array) so the per-group tool files can import it
 * without a circular import — `tools.ts` assembles the groups and re-exports `ToolDef`/`ToolDeps`.
 */
import { z } from 'zod';
import { ReticleCommand, SnapshotMode } from '@reticlehq/core';
import type { SessionManager } from '../session/session.js';
import type { RealInputProvider } from '../input/real-input.js';
import type { BaselineStore } from '../project/baselines.js';
import { normalizeLines } from '../project/baselines.js';
import type { RecordingStore } from '../flows/recordings.js';
import type { FileSystemPort } from '../project/fs-port.js';
import type { FlowStore } from '../flows/flows.js';
import type { ProjectStore } from '../project/project-store.js';
import type { AnnotationStore } from '../flows/annotation-store.js';
import type { BrowserPool } from '../pool/browser-pool.js';

export interface ToolDeps {
  sessions: SessionManager;
  /** shared one-browser/N-context pool for headless leases. undefined ⇒ lease tools report unavailable. */
  pool?: BrowserPool;
  baselines: BaselineStore;
  recordings: RecordingStore;
  /** on-disk anchored-flow store (.reticle/flows/). */
  flows: FlowStore;
  /** structured annotations accumulating for the live recording. */
  annotations: AnnotationStore;
  /** cross-run outcome memory (.reticle/project.json). */
  project: ProjectStore;
  /** optional native-input provider. undefined ⇒ everything stays synthetic. */
  realInput?: RealInputProvider;
  /** injected filesystem seam (tests pass a fake/temp-dir adapter). */
  fs: FileSystemPort;
  /** absolute.reticle path (index.ts computes cwd/.reticle). */
  reticleRoot: string;
  /**
   * This daemon's OWN project id, derived from the directory it was started in.
   *
   * Optional because a daemon above an uninitialised directory has none, and because every existing
   * test construction of ToolDeps predates it. Absence means "cannot tell", which must never be
   * treated as a mismatch.
   */
  projectId?: string;
  /** injected clock for the contract's generatedAt stamp. */
  now: () => number;
  /**
   * The port this daemon's bridge listens on.
   *
   * Needed wherever a message has to name the OTHER half of a port mismatch — the commonest reason
   * a leased tab loads the app and never dials in. Optional so every existing test construction of
   * ToolDeps keeps working; absent falls back to the default port.
   */
  bridgePort?: number;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  /**
   * JSON Schema-compatible output schema for this tool. When present, the MCP server advertises it
   * in the tools/list response so schema-aware clients (like @reticlehq/cli) can validate outputs and
   * compose tool calls safely. Also drives TOON encoding for snapshot/query results.
   */
  outputSchema?: z.ZodRawShape;
  /**
   * One concrete, valid call — the shape, not the prose.
   *
   * A schema tells an agent the FIELD NAMES; it does not tell it how they compose, and under a lean
   * profile only the first sentence of the description survives. So an agent reads "execute one
   * action against a ref", sees `ref` / `action` / `args`, and guesses `{ action, testid }`. The
   * guess fails inside the MCP SDK's own validation — BEFORE this package's error handling runs — so
   * what comes back is a raw zod dump: the validator's internal state, naming no field and showing
   * no correct shape. Two of those round trips cost more than the lean snapshot saves, which means
   * arg-guessing quietly refunds the entire token advantage.
   *
   * Rendered into the advertised description, so it survives the terse profiles where it matters
   * most. `tool-examples.test.ts` parses every one of these against its OWN inputSchema, because an
   * example that does not validate is worse than none at all.
   */
  example?: Record<string, unknown>;
  handler: (deps: ToolDeps, args: Record<string, unknown>) => Promise<unknown>;
}

export const sessionIdShape = {
  sessionId: z
    .string()
    .optional()
    .describe(
      'OMIT THIS unless you mean a specific tab — Reticle scopes to your project, prefers the active one, and refuses rather than guesses when ambiguous. Pass an id from reticle_sessions only to target a particular tab. The previous wording ("omit when only ONE session is open") was wrong and cost real turns: with three sessions connected — an app plus two pool leases — resolution is still unambiguous, but that sentence sent the agent off to list and filter sessions by hand before every single call.',
    ),
};

/**
 * Fields that `runTool` / `withControl` splice onto EVERY session-bound tool result at runtime
 * (health, pool lease reminder, age cleanup nudge, and the delivered-once human-control envelope).
 * They are declared here and merged into each session-bound tool's outputSchema so a schema-strict
 * client (structuredContent validation) keeps them instead of silently dropping them — the `control`
 * envelope is the human-in-the-loop guidance channel, so losing it is a safety failure, not cosmetic.
 */
export const sessionEnvelopeShape: z.ZodRawShape = {
  session: z.unknown().optional(),
  session_lease: z.unknown().optional(),
  session_age_warning: z.unknown().optional(),
  control: z.unknown().optional(),
  // `warning` rides alongside `session` whenever the tab is THROTTLED (healthEnvelope splices both).
  // It was declared on reticle_act's schema but nowhere else, so on a validating profile every other
  // session-bound tool (observe, assert, wait_for, act_sequence, act_and_wait, snapshot, query, …)
  // silently dropped it — a throttled tab, where drives can no-op, returned a healthy-looking result.
  // That is exactly what invoke-tool.ts's health splice exists to prevent, so it belongs in the shared
  // envelope, not per-tool.
  warning: z.string().optional(),
  // The one-shot "ask the human how this went" envelope. Undeclared, a validating profile would strip
  // it — and a feedback prompt that never reaches the agent is a feedback prompt that never reaches
  // the person, which is the entire failure mode this channel exists to fix.
  feedback_prompt: z.unknown().optional(),
  // One-shot "a newer Reticle exists" notice. Undeclared, a validating profile would strip it and the
  // agent would never learn an update was waiting.
  update_available: z.unknown().optional(),
};

/** Unwrap a browser command result or throw its error so the agent sees a clean failure. */
export async function commandOrThrow(
  deps: ToolDeps,
  sessionId: string | undefined,
  // ReticleCommand, not string: the union already exists and every caller passes a member. Typed as
  // `string` a sessionId/name swap compiled cleanly and failed at runtime with a stringly error.
  name: ReticleCommand,
  args: Record<string, unknown>,
): Promise<unknown> {
  const session = deps.sessions.resolve(sessionId);
  const result = await session.command(name, args);
  if (!result.ok) throw new Error(result.error ?? `command '${name}' failed`);
  return result.result;
}

interface SnapshotResult {
  tree?: string;
  status?: { route?: string };
}

/** Full DOM snapshot → normalized tree lines + route, for tools that diff or scan the page. */
export async function snapshotTree(
  deps: ToolDeps,
  sessionId: string | undefined,
): Promise<{ lines: string[]; route: string }> {
  const session = deps.sessions.resolve(sessionId);
  const result = await session.command(ReticleCommand.SNAPSHOT, { mode: SnapshotMode.FULL });
  if (!result.ok) throw new Error(result.error ?? 'snapshot failed');
  const snap = (result.result ?? {}) as SnapshotResult;
  return { lines: normalizeLines(snap.tree ?? ''), route: snap.status?.route ?? '' };
}
