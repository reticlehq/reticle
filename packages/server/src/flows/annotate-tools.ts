import { z } from 'zod';
import { AnnotationErrorCode, AnnotationSchema, type AnnotateResult } from '@syrin/iris-protocol';
import { IrisTool } from '../tools/tool-names.js';
import { asString } from '../tools/tools-helpers.js';
import { compileAnnotation } from './annotate.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';

const DEFAULT_RECORDING = 'default';

/**
 * The iris_annotate tool. A STRUCTURED annotation (the AnnotationSchema
 * discriminated union) is compiled into the live recording's per-step expect / flow dynamic[] /
 * flow success, which iris_flow_save then folds onto disk. Returns the AnnotateResult envelope
 * with the compiled-predicate confirmation text ("will assert signal diff:shown").
 *
 * FIRST CUT: structured annotations only. A free NATURAL-LANGUAGE annotation never compiles — it
 * fails AnnotationSchema and is returned as UNKNOWN_KIND. NL → predicate compilation is explicitly
 * FUTURE; no NL parser exists or is faked here.
 *
 * No-active-recording and no-step are SAFE, returned as structured codes (never thrown), so an
 * agent that annotates at the wrong moment gets a clear error rather than a crash.
 */
export const ANNOTATE_TOOLS: ToolDef[] = [
  {
    name: IrisTool.ANNOTATE,
    description:
      'Attach a STRUCTURED annotation to the active recording, compiling it into the flow. kind: ' +
      'assert-signal { name, dataMatches? } → the last step asserts that signal; assert-visible ' +
      '{ testid } → the last step asserts that element is present; assert-state ' +
      '{ statePath, store?, equals? } → the last step asserts a registered store value (the source ' +
      'of truth no DOM read can reach); mark-dynamic { testid } → the ' +
      "flow records that region as LLM-dynamic (replay won't assert its content); success-state " +
      '{ signal | statePath(+store,+equals) | net(+count) | console(+absent) | testid } → the flow golden ' +
      'end-condition (statePath asserts a registered store value — the source of truth no DOM read can ' +
      'reach; net asserts a request fired EXACTLY `count` times — catches double-submit; console+absent ' +
      'asserts a clean console — catches an action that logs an error). Folded onto disk by iris_flow_save. ' +
      'Returns { ok:true, target:step|flow, compiled } (e.g. "will assert signal diff:shown") or ' +
      '{ ok:false, code } (annotate_no_recording | annotate_no_step | annotate_unknown_kind | ' +
      'annotate_missing_field). FIRST CUT: structured only — a free natural-language string is ' +
      'rejected (annotate_unknown_kind), never guessed into a predicate. Pass `flow` to target a ' +
      "named recording (defaults to 'default'); `name` is the assert-signal's SIGNAL name, not the recording.",
    inputSchema: {
      // `flow` selects the recording; `name`/`signal`/`testid`/`dataMatches` are the annotation fields.
      flow: z.string().optional().describe("Named recording to annotate. Defaults to 'default'."),
      kind: z
        .string()
        .describe(
          'Annotation kind: assert-signal | assert-visible | assert-state | mark-dynamic | success-state | intent.',
        ),
      name: z.string().optional().describe('Signal name for assert-signal annotations.'),
      text: z
        .string()
        .optional()
        .describe("Business goal for an intent annotation, e.g. 'ship a deploy to production'."),
      testid: z
        .string()
        .optional()
        .describe(
          'data-testid value for assert-visible / mark-dynamic / success-state annotations.',
        ),
      signal: z.string().optional().describe('Signal name for success-state annotations.'),
      statePath: z
        .string()
        .optional()
        .describe(
          "Store dot-path for an assert-state (last step) or success-state (golden end) store-truth assertion (e.g. 'deployments.0.status'). With `store` and optional `equals` — asserts the app's source of truth, not just the DOM.",
        ),
      store: z
        .string()
        .optional()
        .describe('Store name for a statePath assert-state/success-state annotation.'),
      equals: z
        .unknown()
        .optional()
        .describe('Expected value for statePath: a literal, or a { $gte | $contains | $length }.'),
      hold: z
        .boolean()
        .optional()
        .describe(
          'Treat statePath as an INVARIANT that must still hold AFTER the action settles (a blast-radius "this unrelated path must not have moved" check), not a condition to wait for. Without it a wait-until-true read passes before an over-reaching side-effect lands.',
        ),
      dataMatches: z
        .record(z.unknown())
        .optional()
        .describe('Key/value pairs the signal payload must match (assert-signal only).'),
      net: z
        .object({
          method: z.string().optional(),
          urlContains: z.string().optional(),
          status: z.number().optional(),
          count: z.number().int().nonnegative().optional(),
        })
        .optional()
        .describe(
          'Network golden end-condition for success-state: the flow succeeds only when EXACTLY `count` requests match { method?, urlContains?, status? } since the action (omit count = presence). Catches the double-submit / retry-storm regression a presence check passes.',
        ),
      console: z
        .object({
          level: z.string().optional(),
          absent: z.boolean().optional(),
        })
        .optional()
        .describe(
          'Console golden end-condition for success-state: with absent:true the flow succeeds only when the action logged NO console message at `level` (default "error") — "completed with a clean console". Catches an action that logs a caught error/rejection while the UI still renders fine.',
        ),
      sessionId: z
        .string()
        .optional()
        .describe(
          'Active session ID from iris_sessions. Omit when only one browser session is open.',
        ),
      annotation: z
        .unknown()
        .optional()
        .describe(
          'Structured annotation: { kind, name, dataMatches? } for assert-signal; { kind, testid } for assert-visible / mark-dynamic; { kind, signal?, testid? } for success-state.',
        ),
    },
    outputSchema: {
      ok: z.boolean(),
      target: z.string().optional(),
      compiled: z.string().optional(),
      code: z.string().optional(),
    },
    handler: (deps: ToolDeps, args): Promise<AnnotateResult> => {
      const name = asString(args['flow']) ?? DEFAULT_RECORDING;

      // Structured boundary: a free NL string / unknown kind fails the schema → UNKNOWN_KIND.
      const parsed = AnnotationSchema.safeParse(args);
      if (!parsed.success) {
        return Promise.resolve({ ok: false, code: AnnotationErrorCode.UNKNOWN_KIND });
      }

      const stepCount = deps.recordings.stepCount(name);
      const compiled = deps.recordings.getCompiled(name) !== undefined;
      if (stepCount === undefined && !compiled) {
        return Promise.resolve({ ok: false, code: AnnotationErrorCode.NO_ACTIVE_RECORDING });
      }

      const outcome = compileAnnotation(parsed.data, stepCount ?? 0);
      if (!outcome.result.ok) return Promise.resolve(outcome.result);

      const patch = outcome.patch;
      if (patch !== undefined) {
        if (patch.dynamicAdd !== undefined) deps.annotations.addDynamic(name, patch.dynamicAdd);
        if (patch.success !== undefined) deps.annotations.setSuccess(name, patch.success);
        if (patch.intent !== undefined) deps.annotations.setIntent(name, patch.intent);
        if (patch.stepIndex !== undefined && patch.stepExpect !== undefined) {
          deps.annotations.setStepExpect(name, patch.stepIndex, patch.stepExpect);
        }
      }
      return Promise.resolve(outcome.result);
    },
  },
];
