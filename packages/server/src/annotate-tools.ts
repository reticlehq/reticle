import { z } from 'zod';
import { AnnotationErrorCode, AnnotationSchema, type AnnotateResult } from '@syrin/iris-protocol';
import { IrisTool } from './tool-names.js';
import { asString } from './tools-helpers.js';
import { compileAnnotation } from './annotate.js';
import type { ToolDef, ToolDeps } from './tools.js';

const DEFAULT_RECORDING = 'default';

/**
 * M8 Stage B ANNOTATE — the iris_annotate tool. A STRUCTURED annotation (the AnnotationSchema
 * discriminated union) is compiled into the live recording's per-step expect / flow dynamic[] /
 * flow success, which iris_flow_save then folds onto disk. Returns the AnnotateResult envelope
 * with the compiled-predicate confirmation text ("will assert signal diff:shown").
 *
 * FIRST CUT: structured annotations only. A free NATURAL-LANGUAGE annotation never compiles — it
 * fails AnnotationSchema and is returned as UNKNOWN_KIND. NL → predicate compilation is explicitly
 * FUTURE (M8 Stage C); no NL parser exists or is faked here.
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
      '{ testid } → the last step asserts that element is present; mark-dynamic { testid } → the ' +
      "flow records that region as LLM-dynamic (replay won't assert its content); success-state " +
      '{ signal | testid } → the flow golden end-condition. Folded onto disk by iris_flow_save. ' +
      'Returns { ok:true, target:step|flow, compiled } (e.g. "will assert signal diff:shown") or ' +
      '{ ok:false, code } (annotate_no_recording | annotate_no_step | annotate_unknown_kind | ' +
      'annotate_missing_field). FIRST CUT: structured only — a free natural-language string is ' +
      'rejected (annotate_unknown_kind), never guessed into a predicate. Pass `flow` to target a ' +
      "named recording (defaults to 'default'); `name` is the assert-signal's SIGNAL name, not the recording.",
    inputSchema: {
      // `flow` selects the recording; `name`/`signal`/`testid`/`dataMatches` are the annotation fields.
      flow: z.string().optional(),
      kind: z.string(),
      name: z.string().optional(),
      testid: z.string().optional(),
      signal: z.string().optional(),
      dataMatches: z.record(z.unknown()).optional(),
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
        if (patch.stepIndex !== undefined && patch.stepExpect !== undefined) {
          deps.annotations.setStepExpect(name, patch.stepIndex, patch.stepExpect);
        }
      }
      return Promise.resolve(outcome.result);
    },
  },
];
