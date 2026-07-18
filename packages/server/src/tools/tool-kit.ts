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
  /** absolute .reticle path (index.ts computes cwd()/.reticle). */
  reticleRoot: string;
  /** injected clock for the contract's generatedAt stamp. */
  now: () => number;
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
  handler: (deps: ToolDeps, args: Record<string, unknown>) => Promise<unknown>;
}

export const sessionIdShape = {
  sessionId: z
    .string()
    .optional()
    .describe(
      'Active session ID from reticle_sessions. Omit when only one browser session is open — Reticle resolves it automatically.',
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
};

/** Unwrap a browser command result or throw its error so the agent sees a clean failure. */
export async function commandOrThrow(
  deps: ToolDeps,
  sessionId: string | undefined,
  name: string,
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
