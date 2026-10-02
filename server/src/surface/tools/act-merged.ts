import type { ToolDef, ToolDeps } from './tool-kit.js';

/**
 * `reticle_act`, absorbing `reticle_act_sequence`, routed on SHAPE rather than on a discriminator.
 *
 * Every other merge in this package dispatches on an `action` field. This one cannot: `reticle_act`
 * already owns `action`, and it means the DOM action (click/fill/press). Adding a dispatch enum of
 * the same name silently replaces it and makes the whole family unroutable — see
 * `refuseDiscriminatorCollision`, which now refuses that at build time because this is the merge
 * that found it.
 *
 * So the routing is the one thing the two calls genuinely disagree about: a sequence has `steps`,
 * a single action does not. That is not a heuristic — `steps` is required on one and absent from the
 * other's schema, so the two shapes are disjoint by construction.
 *
 * `act_and_wait` is deliberately NOT part of this. It is the only acting tool that names the expected
 * consequence BEFORE the action and returns a verdict, and folding it in here would turn the proof
 * into an optional parameter. A forgotten tool name is an error; a forgotten parameter is a silent
 * non-verdict, which is the shape of the only false green this repository has ever measured.
 */
export function mergeActWithSequence(act: ToolDef, sequence: ToolDef): ToolDef {
  const optional = (shape: ToolDef['inputSchema']): ToolDef['inputSchema'] => {
    const out: ToolDef['inputSchema'] = {};
    for (const [key, schema] of Object.entries(shape)) {
      out[key] = schema.isOptional() ? schema : schema.optional();
    }
    return out;
  };
  return {
    name: act.name,
    description:
      `${act.description}\n\nSEQUENCE: pass \`steps\` instead of \`ref\`/\`action\` to run several ` +
      `actions in one call, which is one round trip rather than one per step. ${sequence.description}`,
    ...(act.example === undefined ? {} : { example: act.example }),
    inputSchema: { ...optional(act.inputSchema), ...optional(sequence.inputSchema) },
    handler: (deps: ToolDeps, args: Record<string, unknown>) => {
      // `steps` is required by the sequence schema and absent from act's, so presence is the whole
      // question. An empty array still routes to the sequence handler, which already refuses it and
      // says why — better than act's "no ref" complaint about a call that named no ref on purpose.
      const batched = Array.isArray(args['steps']);
      const single = args['ref'] !== undefined || args['target'] !== undefined;
      // Both halves named at once is AMBIGUOUS, and routing on `steps` would silently run the
      // sequence and drop the single action the caller also wrote. Merging made this reachable:
      // before it, the two calls were two tools and the question could not be asked. Refused rather
      // than guessed, for the reason every ambiguity in this codebase is refused — a guess that
      // happens to be right teaches the caller that the call was right.
      if (batched && single) {
        return Promise.resolve({
          error:
            'ambiguous call: `steps` runs a sequence and `ref`/`target` runs one action, and this ' +
            'names both. Send `steps` on its own to batch, or `ref` + `action` on its own for one.',
        });
      }
      return batched ? sequence.handler(deps, args) : act.handler(deps, args);
    },
  };
}
