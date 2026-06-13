import { z } from 'zod';
import {
  ActionType,
  AnchorKind,
  type DriftReason,
  ElementState,
  FLOW_FILE_VERSION,
  QueryBy,
  type ReplayStatus,
} from './constants.js';

/** A query describing which element(s) to find, Testing-Library style. */
export const ElementQuerySchema = z.object({
  by: z.nativeEnum(QueryBy).optional(),
  value: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  testid: z.string().optional(),
  alt: z.string().optional(),
  /** CSS selector or ref to scope the search. */
  scope: z.string().optional(),
});
export type ElementQuery = z.infer<typeof ElementQuerySchema>;

/** Compact semantic descriptor of one element surfaced to the agent. */
export interface ElementDescriptor {
  ref: string;
  role: string;
  name: string;
  value?: string;
  states: ElementState[];
  visible: boolean;
  text?: string;
}

export interface MatchResult {
  matched: boolean;
  count: number;
  elements: ElementDescriptor[];
}

/** Diagnostic hint attached to a zero-match iris_query result (F4). */
export interface QueryEmptyHint {
  /** location.pathname + location.search at query time. */
  route: string;
  /** Up to ~12 data-testid values actually present in the searched DOM scope. */
  presentTestids: string[];
  /** True if a capability-registered testid is present in the scope. */
  knownEmptyState: boolean;
}

/** Result of the QUERY command / iris_query tool. `hint` present ONLY on zero matches. */
export interface QueryResult {
  elements: ElementDescriptor[];
  hint?: QueryEmptyHint;
}

/** One named flow advertised by the app (mirrors the browser CapabilityFlow). */
export const CapabilityFlowSchema = z.object({
  name: z.string(),
  steps: z.array(z.string()),
});

/** The app's testable surface — persisted form of the browser Capabilities (M8 Stage A). */
export const CapabilitiesSchema = z.object({
  testids: z.array(z.string()),
  signals: z.array(z.string()),
  stores: z.array(z.string()),
  flows: z.array(CapabilityFlowSchema),
});
export type CapabilitiesContract = z.infer<typeof CapabilitiesSchema>;

/** The on-disk contract.json envelope: versioned + timestamped capabilities (M8 Stage A). */
export const ContractFileSchema = z.object({
  version: z.number(),
  generatedAt: z.number(),
  capabilities: CapabilitiesSchema,
});
export type ContractFile = z.infer<typeof ContractFileSchema>;

/**
 * M8 Stage A FLOWFMT — a semantic anchor: how a step re-finds its element/event at replay
 * time. Never a volatile eXX ref. testid/role+name bind a DOM element; signal binds an event.
 */
export const FlowAnchorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal(AnchorKind.TESTID), value: z.string().min(1) }),
  z.object({
    kind: z.literal(AnchorKind.ROLE),
    role: z.string().min(1),
    name: z.string().optional(),
  }),
  z.object({ kind: z.literal(AnchorKind.SIGNAL), name: z.string().min(1) }),
]);
export type FlowAnchor = z.infer<typeof FlowAnchorSchema>;

/** A post-condition a step asserts (compiled from a Stage-B annotation; sparse in Stage A). */
export const FlowExpectSchema = z.object({
  signal: z.string().optional(),
  net: z
    .object({
      method: z.string().optional(),
      urlContains: z.string().optional(),
      status: z.number().optional(),
    })
    .optional(),
  element: z
    .object({
      testid: z.string().optional(),
      role: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
});
export type FlowExpect = z.infer<typeof FlowExpectSchema>;

/** One step of a flow: an anchored action (+ optional expectation). */
export interface FlowStep {
  /** IrisTool.ACT | IrisTool.ACT_SEQUENCE (the server-side tool constant). */
  tool: string;
  anchor: FlowAnchor;
  action?: ActionType;
  args?: Record<string, unknown>;
  expect?: FlowExpect;
  /** true when the anchor is best-effort (no testid was resolvable at record time). NOT dropped. */
  degraded?: boolean;
  /** sub-steps for an act_sequence, each independently anchored. */
  steps?: FlowStep[];
}

const baseFlowStep = z.object({
  tool: z.string(),
  anchor: FlowAnchorSchema,
  action: z.nativeEnum(ActionType).optional(),
  args: z.record(z.unknown()).optional(),
  expect: FlowExpectSchema.optional(),
  degraded: z.boolean().optional(),
});

export const FlowStepSchema: z.ZodType<FlowStep> = baseFlowStep.extend({
  steps: z.lazy(() => z.array(FlowStepSchema).optional()),
}) as z.ZodType<FlowStep>;

/**
 * M8 Stage A REPLAYANCHOR — a legible-drift record returned when an anchor misses at replay.
 * The "whose fault is it" payload: what was expected, why it's gone, and the closest surviving
 * anchor (a concrete fix suggestion). Never a bare "command failed".
 */
export interface Drift {
  /** Named reason kind (testid not found / signal not observed). */
  reasonKind: DriftReason;
  /** Human sentence, e.g. `testid "chat-send" not found`. */
  reason: string;
  /** The missed anchor value (the testid string, or the signal name). */
  anchor: string;
  /** Closest present testid via the live near-miss; null only when the page has no testids (or signal drift). */
  nearest: string | null;
}

/** M8 Stage A REPLAYANCHOR — the per-step result of re-resolving + running one anchored step. */
export interface FlowStepResult {
  /** 0-based index of this step in the flow. */
  step: number;
  /** The server-side tool constant the step runs (IrisTool.ACT | ACT_SEQUENCE). */
  tool: string;
  /** The testid/signal value the step is bound to (the re-resolved anchor). */
  anchor: string;
  ok: boolean;
  error?: string;
  note?: string;
  /** Present iff this step stopped on an anchor miss. */
  drift?: Drift;
}

/** M8 Stage A REPLAYANCHOR — the iris_flow_replay envelope. */
export interface FlowReplayResult {
  name: string;
  status: ReplayStatus;
  steps: FlowStepResult[];
  /** Set when status === 'error' (missing/invalid file) — no steps ran. */
  error?: { code: string; message: string };
}

/** The on-disk flow file: diffable, git-tracked, anchor-resolved (M8 Stage A FLOWFMT). */
export const FlowFileSchema = z.object({
  version: z.literal(FLOW_FILE_VERSION),
  name: z.string(),
  fixture: z.string().optional(),
  /** From the injected clock (ms) — deterministic in tests, byte-stable on disk. */
  createdAt: z.number(),
  steps: z.array(FlowStepSchema),
  success: FlowExpectSchema.optional(),
});
export type FlowFile = z.infer<typeof FlowFileSchema>;
