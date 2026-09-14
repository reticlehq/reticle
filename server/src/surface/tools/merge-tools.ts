import { z } from 'zod';
import type { ToolDef, ToolDeps } from './tool-kit.js';

/**
 * Surface consolidation. Tool definitions are re-sent to the model EVERY turn, so the named-def
 * count is a per-turn tax multiplied by loop length. This merges a family of sibling tools
 * (`baseline_save`/`baseline_list`/`diff`) into one action-dispatched tool (`reticle_baseline {action}`)
 * WITHOUT rewriting any handler — each original handler is kept verbatim and selected by `action`, so a
 * merge cannot change behavior, only the advertised shape.
 *
 * The merged input schema is `{ action }` plus the union of the members' fields, each made optional
 * (different actions need different fields). Every handler already narrows its own args, so validation
 * strength is unchanged in practice.
 *
 * TRADEOFF (deliberate): a merged tool carries NO `outputSchema`, because its members return different
 * shapes and one schema cannot describe them. Schema-aware clients lose output validation for merged
 * families. That is why tools whose result contract matters — the 12-tool core hot-set, and hot verbs
 * like flow_replay/flow_verify/flow_heal that return their own documented verdict shapes — are NOT
 * merged. Only sibling families whose value is the capability, not the contract, are consolidated.
 */
interface MergeSpec {
  name: string;
  description: string;
  /** action value → the original tool whose handler serves it. */
  actions: Record<string, ToolDef>;
  /** A concrete call, carried through to the merged def (see ToolDef.example). */
  example?: Record<string, unknown>;
  /**
   * The action a bare call means. Omit where there is no obvious one.
   *
   * MEASURED, and it is the difference between a surface an agent uses and one it abandons. An
   * agent's first two moves are zero-argument: "is anything connected?" then "what is on the page?".
   * Merging turned both into `{action}` calls that refused a bare invocation, so the first move
   * answered `unknown action 'undefined'`, the agent concluded the app was not wired, and it fixed
   * all five benchmark bugs by reading source instead — 84 drive calls on the unmerged surface
   * against 0, and one false green it reached in eight turns without ever opening the app.
   *
   * So a family whose common case is obvious names it, and a family whose name implies no single
   * member does NOT — see `reticle_verify`, where one member really clicks and a wrong guess would
   * drive the app instead of reading it.
   */
  defaultAction?: string;
}

/** The field the merged tool dispatches on. A member may not declare one of its own — see below. */
const DISCRIMINATOR = 'action';

/** The union of member input shapes, every field optional so one schema serves every action. */
function unionShape(actions: Record<string, ToolDef>): z.ZodRawShape {
  const shape: z.ZodRawShape = {};
  for (const tool of Object.values(actions)) {
    for (const [key, schema] of Object.entries(tool.inputSchema)) {
      // First definition wins; siblings share field names/meanings by construction.
      shape[key] ??= schema.isOptional() ? schema : schema.optional();
    }
  }
  return shape;
}

/**
 * A member that declares `action` itself cannot be merged, and the failure was SILENT.
 *
 * The merged schema is `{ action: enum(...), ...unionShape(members) }` — the union spreads SECOND,
 * so a member's own `action` field replaced the dispatch enum. The handler then read `args.action`
 * expecting a member name, got `'click'`, and answered `unknown action 'click'` for every call. The
 * tool would have advertised, validated and refused everything.
 *
 * Nothing shipped this: it was found while merging `reticle_act` (whose `action` is the DOM action:
 * click/fill/press) into a family, which is exactly the shape that triggers it. It throws at module
 * load like the unknown-member error above, because both are the same class of mistake — a plan that
 * silently produces a surface nobody can call.
 */
function refuseDiscriminatorCollision(name: string, actions: Record<string, ToolDef>): void {
  for (const [action, tool] of Object.entries(actions)) {
    if (DISCRIMINATOR in tool.inputSchema) {
      throw new Error(
        `mergeTools(${name}): member '${tool.name}' (action '${action}') declares its own ` +
          `'${DISCRIMINATOR}' parameter, which would overwrite the dispatch discriminator and make ` +
          `every call to ${name} unroutable. Rename the member's parameter or leave it unmerged.`,
      );
    }
  }
}

/** A merge declared by member NAME, resolved against the assembled tool list. */
export interface MergePlan {
  name: string;
  description: string;
  /** action value → the existing tool name whose handler serves it. */
  members: Record<string, string>;
  /**
   * A concrete call for the merged tool. Merging discards the members' own examples — the schema is
   * a union and theirs are per-member — so a merged tool that reaches the core surface has no
   * example at all unless the plan states one.
   */
  example?: Record<string, unknown>;
  /** What a bare call means. See MergeSpec.defaultAction for the measurement behind this. */
  defaultAction?: string;
}

/**
 * Apply the consolidation to an assembled tool list: drop each plan's members and each retired name from
 * the advertised surface, and append one action-dispatched tool per plan. Member ToolDefs stay defined in
 * their own modules (handlers untouched) — they simply stop being advertised separately, which is the
 * whole point: the cost is the advertised count, not the code.
 *
 * A plan naming a member that does not exist is a build error, not a silent no-op — a typo would
 * otherwise quietly drop a capability from the surface.
 */
export function applyMerges(
  tools: readonly ToolDef[],
  plans: readonly MergePlan[],
  retired: readonly string[] = [],
): ToolDef[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const consumed = new Set<string>(retired);
  const merged: ToolDef[] = [];
  for (const plan of plans) {
    const actions: Record<string, ToolDef> = {};
    for (const [action, memberName] of Object.entries(plan.members)) {
      const member = byName.get(memberName);
      if (member === undefined) {
        throw new Error(`applyMerges(${plan.name}): unknown member tool '${memberName}'`);
      }
      actions[action] = member;
      consumed.add(memberName);
    }
    merged.push(
      mergeTools({
        name: plan.name,
        description: plan.description,
        actions,
        ...(plan.example === undefined ? {} : { example: plan.example }),
        ...(plan.defaultAction === undefined ? {} : { defaultAction: plan.defaultAction }),
      }),
    );
  }
  return [...tools.filter((t) => !consumed.has(t.name)), ...merged];
}

/**
 * The dispatch parameter: required where a bare call means nothing, optional where it means the
 * default. Optional is what lets `reticle_look {}` answer instead of refusing, which is the whole
 * reason a merged surface is usable at all.
 */
function discriminatorSchema(
  actionNames: readonly string[],
  defaultAction: string | undefined,
): z.ZodTypeAny {
  const values = z.enum(actionNames as [string, ...string[]]);
  if (defaultAction === undefined) return values.describe('Which operation to run.');
  return values.describe(`Which operation to run. Omit for "${defaultAction}".`).optional();
}

export function mergeTools(spec: MergeSpec): ToolDef {
  const actionNames = Object.keys(spec.actions);
  if (0 === actionNames.length) throw new Error(`mergeTools(${spec.name}): no actions`);
  refuseDiscriminatorCollision(spec.name, spec.actions);
  if (spec.defaultAction !== undefined && !(spec.defaultAction in spec.actions)) {
    throw new Error(
      `mergeTools(${spec.name}): defaultAction '${spec.defaultAction}' is not one of its actions`,
    );
  }
  return {
    name: spec.name,
    description: spec.description,
    ...(spec.example === undefined ? {} : { example: spec.example }),
    inputSchema: {
      [DISCRIMINATOR]: discriminatorSchema(actionNames, spec.defaultAction),
      ...unionShape(spec.actions),
    },
    handler: (deps: ToolDeps, args: Record<string, unknown>) => {
      const named = args[DISCRIMINATOR];
      const action = 'string' === typeof named ? named : spec.defaultAction;
      const chosen = action === undefined ? undefined : spec.actions[action];
      if (chosen === undefined) {
        return Promise.resolve({
          error: `unknown action '${String(action)}' for ${spec.name}`,
          expected: actionNames,
        });
      }
      return chosen.handler(deps, args);
    },
  };
}
