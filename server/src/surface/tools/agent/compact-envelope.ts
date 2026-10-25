/**
 * The compact envelope: what a verdict result carries by default, and what waits behind
 * `detail: "full"`.
 *
 * The rule (plan: "the middle ground — what a result carries"): answer the question, include what
 * decides the next move, and give a cursor for the rest. A click on a cache-backed page used to
 * return several thousand tokens, most of it store snapshots and counters, and the verdict was a
 * field among them. Compaction never touches a decisive key — `verified`, `because`, the verdict's
 * expected/observed/evidence, contradictions, capture integrity, failed requests, console errors,
 * the acted element's source — and `compact-envelope.contract.test.ts` fails the build if it ever
 * does. What it drops is redundant (identity fields the agent sent), restated (counts the `changed`
 * line already says) or always one `reticle_observe { since }` away.
 *
 * It works by DROPPING named keys, never by allow-listing: a field added to a result later survives
 * compaction until somebody decides it should not. The accurate direction to fail in.
 *
 * Applied once, at the dispatch chokepoint, to an agent's own calls. The Harness and the HUD read
 * the full result; so does telemetry, which runs before this.
 */
import { z } from 'zod';
import { ReticleTool, asRecord, predicateAliasesUsed } from '@reticlehq/core';

/** The argument that asks for today's full envelope. */
export const DETAIL_ARG = 'detail';
export const Detail = { COMPACT: 'compact', FULL: 'full' } as const;
export type Detail = (typeof Detail)[keyof typeof Detail];

/**
 * The A/B control: `RETICLE_RESULT_DETAIL=full` makes every agent call answer as if it had passed
 * `detail: "full"`, so the agent-loop benchmark can run compact against full on the same build with
 * nothing else different — the measurement CLAUDE.md requires beside any token optimisation.
 */
export const RESULT_DETAIL_ENV = 'RETICLE_RESULT_DETAIL';

/**
 * Did this call (or the daemon's environment) ask for the full envelope AND nothing else — no
 * notices, no re-teach? Only an explicit ask: the A/B control arm, and an agent that said so.
 */
export function wantsFull(args: Record<string, unknown>): boolean {
  return Detail.FULL === args[DETAIL_ARG] || Detail.FULL === process.env[RESULT_DETAIL_ENV];
}

/**
 * Did this call (or the daemon) ask for the compact envelope? Compaction is opt-in: in the
 * agent-loop A/B the compact arm saved little per task and missed one failure the full arm caught,
 * and a token saving ships only beside a correctness measurement that is at least as good.
 */
export function wantsCompact(args: Record<string, unknown>): boolean {
  return Detail.COMPACT === (args[DETAIL_ARG] ?? process.env[RESULT_DETAIL_ENV]);
}

/** The tools whose results are compacted. Each one's full shape stays one argument away. */
export const COMPACTED_TOOLS: ReadonlySet<string> = new Set([
  ReticleTool.ACT_AND_WAIT,
  ReticleTool.ASSERT,
  ReticleTool.WAIT_FOR,
  ReticleTool.ACT_SEQUENCE,
  // The merged surface's `reticle_act` routes `steps` to the sequence handler.
  ReticleTool.ACT,
]);

/** Short enough for the per-turn surface; the reasoning lives in this file and the instructions. */
export const DETAIL_ARG_DESCRIPTION = '"compact" keeps only the deciding fields.';

/** Where the aliases a predicate was normalised from are named. */
export const NORMALIZED_KEY = 'normalized';

/**
 * The aliases the call's predicates were written in (`until`/`predicate`, and each step's `expect`).
 * The parse accepted them silently; this says so, so the canonical spelling is learned once.
 */
function aliasesWritten(args: Record<string, unknown>): string[] {
  const used = [...predicateAliasesUsed(args['until']), ...predicateAliasesUsed(args['predicate'])];
  const steps = args['steps'];
  if (Array.isArray(steps)) {
    steps.forEach((step, i) => {
      for (const alias of predicateAliasesUsed(asRecord(step)['expect'])) {
        used.push(`step ${String(i)}: ${alias}`);
      }
    });
  }
  return used;
}

/** The key the one-line "what changed" summary travels under. */
export const CHANGED_KEY = 'changed';

/** Effect keys that only repeat what the agent sent, or restate a default. */
const EFFECT_IDENTITY_KEYS: readonly string[] = [
  'ok',
  'ref',
  'action',
  'testid',
  'component',
  'role',
  'name',
  'source',
];
/** Nested effect keys that describe the motion, not the outcome. */
const EFFECT_MOTION_KEYS: readonly string[] = ['focusMoved'];

/**
 * Evidence keys that describe HOW a request travelled, not what decided the verdict. Removed only
 * from the evidence's own records, wherever they nest; every other key — the method, url, status,
 * the matched body field — stays.
 */
const EVIDENCE_NOISE_KEYS: ReadonlySet<string> = new Set([
  'initiatorStack',
  'initiator',
  'requestShape',
  'responseSize',
  'requestSize',
  'contentType',
  'statusText',
  'headers',
  'requestHeaders',
  'responseHeaders',
  'timing',
]);
/** A request slower than this keeps its duration: slowness is then the finding. */
const SLOW_MS = 1000;

/** The causal-summary keys that decide something, kept beside the `changed` line. */
const DECISIVE_SUMMARY_KEYS: readonly string[] = [
  'consoleErrors',
  'firstConsoleError',
  'truncated',
  'stateUnwatched',
  'elided',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return 'object' === typeof value && null !== value && !Array.isArray(value);
}

function without(
  record: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out = { ...record };
  for (const key of keys) delete out[key];
  return out;
}

/** Evidence with transport detail removed, recursively, keeping every deciding field. */
export function trimEvidence(value: unknown, depth = 0): unknown {
  if (depth > 4) return value;
  if (Array.isArray(value)) return value.map((item) => trimEvidence(item, depth + 1));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (EVIDENCE_NOISE_KEYS.has(key)) continue;
    if ('durationMs' === key && 'number' === typeof item && item < SLOW_MS) continue;
    out[key] = trimEvidence(item, depth + 1);
  }
  return out;
}

/** `src/x.tsx:81` from a `{file,line}` source record, or the string as given. */
function sourceLabel(source: unknown): string | undefined {
  if ('string' === typeof source) return source;
  if (!isRecord(source) || 'string' !== typeof source['file']) return undefined;
  return 'number' === typeof source['line']
    ? `${source['file']}:${String(source['line'])}`
    : source['file'];
}

/** The `{effect}` of an act, keeping only what says something the agent did not already know. */
function compactEffect(effect: Record<string, unknown>): Record<string, unknown> {
  const out = without(effect, EFFECT_IDENTITY_KEYS);
  if (true === out['dispatched']) delete out['dispatched'];
  if (true === out['settled']) delete out['settled'];
  if (null === out['settleReason'] || undefined === out['settleReason']) delete out['settleReason'];
  const nested = out['effect'];
  if (isRecord(nested)) {
    const lean = without(nested, EFFECT_MOTION_KEYS);
    if (0 === Object.keys(lean).length) delete out['effect'];
    else out['effect'] = lean;
  }
  return out;
}

/**
 * One line naming what moved: the route, the requests, the MEANINGFUL state paths (cache
 * bookkeeping is already filtered out upstream), storage keys, fields and signals.
 */
export function changedLine(summary: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  if ('string' === typeof summary['route']) parts.push(`route ${summary['route']}`);
  const requests = Array.isArray(summary['requests']) ? (summary['requests'] as unknown[]) : [];
  if (requests.length > 0) parts.push(requests.map(String).join(', '));
  const stateDiffs = Array.isArray(summary['stateDiffs'])
    ? (summary['stateDiffs'] as unknown[])
    : [];
  const statePaths = [...new Set(stateDiffs.map((d) => asRecord(d)['path']).map(String))];
  if (statePaths.length > 0) parts.push(`state ${statePaths.join(', ')}`);
  const list = (key: string, label: string): void => {
    const items = summary[key];
    if (Array.isArray(items) && items.length > 0)
      parts.push(`${label} ${items.map(String).join(', ')}`);
  };
  list('storageKeysChanged', 'storage');
  list('fieldsChanged', 'fields');
  list('signals', 'signal');
  return 0 === parts.length ? undefined : parts.join(' · ');
}

/** The causal summary reduced to the facts that decide something, or undefined when none did. */
function decisiveSummary(summary: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const key of DECISIVE_SUMMARY_KEYS) {
    const value = summary[key];
    if (value === undefined || 0 === value) continue;
    out[key] = value;
  }
  const net = asRecord(summary['net']);
  if ('number' === typeof net['errors'] && net['errors'] > 0) {
    out['net'] = {
      errors: net['errors'],
      ...(net['headline'] === undefined ? {} : { headline: net['headline'] }),
    };
  }
  return 0 === Object.keys(out).length ? undefined : out;
}

/** Honesty: the grade, integrity always, the rest only when it says something. */
function compactHonesty(honesty: Record<string, unknown>): Record<string, unknown> {
  const out = { ...honesty };
  if ('window' === out['attribution']) delete out['attribution'];
  const coverage = asRecord(out['coverage']);
  if (true !== coverage['partial']) delete out['coverage'];
  if (true === out['settled']) delete out['settled'];
  return out;
}

/** A gap repeated this session carries no remedy and no news — drop it. */
function freshGaps(gaps: unknown): unknown[] {
  return Array.isArray(gaps) ? gaps.filter((gap) => true !== asRecord(gap)['repeat']) : [];
}

/** The screenshot by path, or the reason there is none. */
function compactScreenshot(shot: unknown): unknown {
  if (!isRecord(shot) || 'string' !== typeof shot['path']) return shot;
  return { path: shot['path'] };
}

/** One verdict result (act_and_wait, assert, wait_for), compacted. Idempotent. */
export function compactVerdict(result: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...result };
  delete out['trace'];
  const effect = out['effect'];
  if (isRecord(effect)) {
    if (out['ref'] === undefined && 'string' === typeof effect['ref']) out['ref'] = effect['ref'];
    const source = sourceLabel(effect['source']);
    if (out['source'] === undefined && source !== undefined) out['source'] = source;
    const lean = compactEffect(effect);
    if (0 === Object.keys(lean).length) delete out['effect'];
    else out['effect'] = lean;
  }
  const verdict = out['verdict'];
  if (isRecord(verdict) && verdict['evidence'] !== undefined) {
    out['verdict'] = { ...verdict, evidence: trimEvidence(verdict['evidence']) };
  }
  const summary = out['summary'];
  // A summary carrying `net` as an object is the full causal summary; a compact one never does.
  if (
    isRecord(summary) &&
    isRecord(summary['net']) &&
    'number' === typeof summary['net']['total']
  ) {
    const line = changedLine(summary);
    if (line !== undefined) out[CHANGED_KEY] = line;
    const decisive = decisiveSummary(summary);
    if (decisive === undefined) delete out['summary'];
    else out['summary'] = decisive;
  }
  if (isRecord(out['honesty'])) out['honesty'] = compactHonesty(out['honesty']);
  if (out['instrumentationGaps'] !== undefined) {
    const gaps = freshGaps(out['instrumentationGaps']);
    if (0 === gaps.length) delete out['instrumentationGaps'];
    else out['instrumentationGaps'] = gaps;
  }
  if (out['screenshot'] !== undefined) out['screenshot'] = compactScreenshot(out['screenshot']);
  // The blast radius on a green mostly restates the `changed` line. Its undeclared REQUESTS are the
  // exception — "it worked, and it also fired a DELETE" — so those stay. On a red it lives in the
  // capsule, which is kept whole.
  if (out[CHANGED_KEY] !== undefined && Array.isArray(out['blastRadius'])) {
    const requests = out['blastRadius'].filter(
      (b) => 'string' === typeof b && b.startsWith('net '),
    );
    if (0 === requests.length) delete out['blastRadius'];
    else out['blastRadius'] = requests;
  }
  return out;
}

/** One sequence step, compacted: the outcome, its source, its screenshot, its contradictions. */
function compactStep(step: unknown): unknown {
  if (!isRecord(step)) return step;
  const out = without(step, ['testid', 'component', 'role', 'name', 'digest']);
  if (true === out['dispatched']) delete out['dispatched'];
  if (true === out['settled']) delete out['settled'];
  if (null === out['settleReason']) delete out['settleReason'];
  const source = sourceLabel(out['source']);
  if (source !== undefined) out['source'] = source;
  if (out['screenshot'] !== undefined) out['screenshot'] = compactScreenshot(out['screenshot']);
  return out;
}

/** A sequence result, compacted per step. Idempotent. */
export function compactSequence(result: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(result['steps'])) return result;
  return { ...result, steps: result['steps'].map(compactStep) };
}

/**
 * The result as an agent receives it: full unless it asked for `detail: "compact"`.
 *
 * `agentCall` is the dispatcher's own judgement (an MCP connection, not the Harness or the HUD).
 */
export function shapeForAgent(
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
  agentCall: boolean,
): unknown {
  if (!agentCall || !COMPACTED_TOOLS.has(tool) || !isRecord(result)) return result;
  const normalized = aliasesWritten(args);
  const noted = 0 === normalized.length ? result : { ...result, [NORMALIZED_KEY]: normalized };
  if (!wantsCompact(args)) return noted;
  if (Array.isArray(noted['steps'])) return compactSequence(noted);
  return 'verified' in noted ? compactVerdict(noted) : noted;
}

/**
 * The compacted tools, with `detail` accepted and the compact-only keys declared.
 *
 * Declared because a schema-strict client validates `structuredContent` against `outputSchema` and
 * drops what is not there: `changed`, `ref` and `source` would be built and silently thrown away.
 */
export function withCompactEnvelope<
  T extends {
    name: string;
    inputSchema: Record<string, z.ZodType>;
    outputSchema?: Record<string, z.ZodType>;
  },
>(tools: T[]): T[] {
  return tools.map((tool) => {
    if (!COMPACTED_TOOLS.has(tool.name)) return tool;
    const output = tool.outputSchema;
    return {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        [DETAIL_ARG]: z
          .enum([Detail.COMPACT, Detail.FULL])
          .optional()
          .describe(DETAIL_ARG_DESCRIPTION),
      },
      ...(output === undefined
        ? {}
        : {
            outputSchema: {
              [CHANGED_KEY]: z.string().optional(),
              ref: z.string().optional(),
              source: z.string().optional(),
              [NORMALIZED_KEY]: z.array(z.string()).optional(),
              caseOnlyMiss: z.boolean().optional(),
              wouldHold: z.string().optional(),
              ...output,
            },
          }),
    };
  });
}
