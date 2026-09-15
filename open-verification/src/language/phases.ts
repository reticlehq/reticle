/**
 * The compiler's stages, named — and what naming them buys.
 *
 * Most of this pipeline already existed and was unnamed. Resolving anchors against `locate()` is the
 * LINK step. `CompiledProgram` is the EMIT step. `Realm.dispatch` returning *"delivered, and that is
 * all this means"* is already a target machine refusing to interpret. Naming the stages does not add
 * behaviour; it adds somewhere to point when meaning starts leaking into the realm, which is the one
 * failure that makes a flow unportable and a verdict incomparable.
 *
 * The ORDER is the content. TYPECHECK sits before EMIT because a program that cannot run must not be
 * built: emitting first and discovering later is exactly the runtime failure the phase exists to
 * prevent, and an emitted program is a thing somebody will be tempted to run.
 */

import {
  typecheckProgram,
  type FlowTypeError,
  type ProgramStep,
  type RealmSurface,
} from './typecheck.js';

export const CompilePhase = {
  /** JSON -> AST, schema-validated. A malformed document never reaches a realm. */
  PARSE: 'parse',
  /** Anchors -> handles, via `locate()`. Drift is found HERE, before anything is dispatched. */
  RESOLVE: 'resolve',
  /** Every action in `capabilities()`, every read in `channels()`. The phase that did not exist. */
  TYPECHECK: 'typecheck',
  /** Capability calls against resolved handles. No semantics left to interpret. */
  EMIT: 'emit',
} as const;
export type CompilePhase = (typeof CompilePhase)[keyof typeof CompilePhase];

export type CompileResult =
  | { ok: true; program: readonly ProgramStep[] }
  | { ok: false; failedAt: CompilePhase; errors: readonly FlowTypeError[] };

/**
 * Typecheck, then emit — and emit NOTHING when the typecheck fails.
 *
 * The absent `program` on a failure is deliberate. A caller holding a half-valid program will
 * eventually run it, and a journey that half-happens on a realm that could not complete it leaves
 * the subject somewhere nobody planned and no verdict can describe.
 */
export function compileFor(steps: readonly ProgramStep[], realm: RealmSurface): CompileResult {
  const errors = typecheckProgram(steps, realm);
  if (errors.length > 0) return { ok: false, failedAt: CompilePhase.TYPECHECK, errors };
  return { ok: true, program: steps };
}

/** Whether one document runs on one realm, and what stands in the way when it does not. */
export interface PortabilityAnswer {
  portable: boolean;
  /** The specific capabilities and channels the realm lacks — never a bare "no". */
  missing: readonly string[];
}

/**
 * Where does this document run?
 *
 * Answered for several realms in one read, because the question is comparative: *this journey runs
 * on web and not on mobile, and here is the one verb that stops it.* A per-realm yes/no would make
 * the caller ask N times and assemble that themselves.
 *
 * Naming what is MISSING rather than returning false is the whole value. "Not portable" ends a
 * conversation; "this realm does not declare `click`" starts the one worth having — either the realm
 * grows the capability, or the journey is genuinely web-only and somebody now knows why.
 */
export function portableAcross(
  steps: readonly ProgramStep[],
  realms: Record<string, RealmSurface>,
): Record<string, PortabilityAnswer> {
  const out: Record<string, PortabilityAnswer> = {};
  for (const [name, realm] of Object.entries(realms)) {
    const errors = typecheckProgram(steps, realm);
    out[name] = {
      portable: 0 === errors.length,
      missing: errors.map((e) => e.detail),
    };
  }
  return out;
}
