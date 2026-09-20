import { z } from 'zod';
import type { ToolDef, ToolDeps } from './tool-kit.js';
import { runTool } from './invoke-tool.js';
import { buildErrorPayload } from './error-recovery.js';
import { mergedNameRedirect, mergedNameMessage, retiredToolNames } from './merged-name-redirect.js';
import { CATALOGUE_SUMMARY_LENGTH, firstSentence } from './first-sentence.js';
import { takeVersionSkewOnto } from '@/command/version/version-nudge.js';
import { ReticleTool } from '@reticlehq/core';
import { ADVERTISE_ALL_ENV, type ToolSurfaceOrigin } from './tool-surface.js';
import { getSessionMetrics } from '@/telemetry/session-metrics.js';
import {
  isPredicateParam,
  predicateGrammar,
} from '@reticlehq/engine/question/predicate/predicate-eval.js';

/**
 * On-demand tool loading for MCP — the answer to the per-turn tool-definition tax.
 *
 * A normal MCP server advertises every tool's full description + schema, and the client re-sends
 * all of them to the model on EVERY turn. Measured here: Reticle at ~5.6k–14.6k tokens/turn just for
 * definitions, which dominates a real agent loop and only grows as the tool surface grows.
 *
 * The `dynamic` profile advertises just TWO meta-tools (~hundreds of tokens, fixed regardless of
 * how many real tools exist):
 * reticle_tools — discover. No args ⇒ a compact catalog (name + one-line summary) of every tool.
 * names:[...] ⇒ full description + params for just those tools, loaded on demand.
 * reticle_run — invoke any tool by name. On a bad/unknown call it returns that tool's params as a
 * hint, so the model self-corrects without ever needing the schema up front.
 *
 * The model lists once, loads the 2–3 tools it actually needs, and calls them — paying for tool
 * detail only when used, not every turn. Works with any MCP client (no client-side support needed).
 */

interface ParamInfo {
  name: string;
  required: boolean;
  description: string;
}

/** Compact param list from a tool's zod shape — name/required/description (the description already
 * carries the type and any enum hints, so no JSON-Schema machinery is needed). */
function paramInfo(shape: z.ZodRawShape): ParamInfo[] {
  return Object.entries(shape).map(([name, schema]) => ({
    name,
    required: !schema.isOptional(),
    description: schema.description ?? '',
  }));
}

/**
 * The one wording for "you named a parameter that does not exist", shared by both checks in
 * `reticle_run` — the one over the WRAPPED tool's `args`, and the one over reticle_run's own
 * top-level keys. Two spellings of the same refusal is how one of them ends up not existing.
 */
function unknownParamsError(toolName: string, unknown: readonly string[]): string {
  return `unknown ${1 === unknown.length ? 'parameter' : 'parameters'} for ${toolName}: ${unknown.join(', ')} — NOT applied, so any result would be an answer to a different question`;
}

/** What to write instead — the one parameter reticle_tools declares, and the no-argument form. */
const TOOLS_ARG_HINT =
  'name the tools you want in `names`: reticle_tools { names: ["reticle_act_and_wait"] } — or call it with no arguments for the full catalog';

/** The keys not declared by `shape`, in call order. */
function unknownKeys(args: Record<string, unknown>, shape: object): string[] {
  const declared = new Set(Object.keys(shape));
  return Object.keys(args).filter((key) => !declared.has(key));
}

/**
 * Build the two dynamic meta-tools over the full tool table. `reticle_run` dispatches through the same
 * `runTool` chokepoint as a direct call, so session-health splicing and every other invariant hold.
 */
export function buildDynamicTools(
  allTools: ToolDef[],
  profile?: ToolSurfaceOrigin,
  /**
   * What this surface can actually INVOKE. Defaults to everything, which is true wherever
   * `reticle_run` is advertised — it reaches any tool in the registry by name.
   *
   * Passed only by a surface that ships no dispatch hatch. Cataloguing a tool nothing can call is
   * worse than hiding it: MEASURED on the nine-tool surface, this listed 66 names of which 57 were
   * uninvokable, and the agent that found `reticle_lease` in it called it four times, failed four
   * times, and then abandoned the product for the rest of the run.
   */
  callable?: ReadonlySet<string>,
): ToolDef[] {
  const reachable =
    callable === undefined ? allTools : allTools.filter((tool) => callable.has(tool.name));
  const byName = new Map(reachable.map((t) => [t.name, t]));
  // The profile is a DAEMON-startup decision, so an agent that exported RETICLE_TOOL_PROFILE into its
  // own environment sees no change and has, until now, no way to tell. Reported with the catalog.
  const profileBlock =
    profile === undefined
      ? {}
      : {
          profile: {
            ...profile,
            // No surface advertises the whole registry, so wherever an unadvertised tail exists,
            // `reticle_run` is the route to it. Wording that implies otherwise sends an agent away
            // from the only tool that can reach half the registry.
            note:
              callable === undefined
                ? `The surface is read once at daemon startup: set ${ADVERTISE_ALL_ENV}=1 and restart the daemon, or it has no effect. No surface advertises every tool: the advertised count is capped because editors budget tools across all connected MCP servers. Every tool listed here is callable through reticle_run { tool, args } whether or not it is advertised.`
                : 'This surface advertises everything it can call, so this list IS the product and every name in it is callable directly. There is no hidden tail and no dispatch hatch to reach one.',
          },
        };

  const toolsShape = {
    names: z
      .array(z.string())
      .optional()
      .describe('Tool names to load full params for. Omit to list all tools with summaries.'),
  };
  const reticleTools: ToolDef = {
    name: ReticleTool.TOOLS,
    // The "invoke them with reticle_run" half is true only where reticle_run exists. On a closed
    // surface it is the first thing an agent reads about this tool and it names a tool that is not
    // there, so it is said only where it can be acted on.
    description:
      'Discover Reticle tools on demand. Call with no arguments to list every tool (name + one-line summary); call with names:["reticle_network", …] to load full descriptions and parameters for specific tools.' +
      (callable === undefined
        ? ' Then invoke them with reticle_run.'
        : ' Every tool it lists is callable directly by name.') +
      ' This avoids paying for every tool definition on every turn.' +
      // The flow workflow is taught ONLY where it can be followed. Three of its four calls —
      // reticle_record, reticle_flow_save, reticle_verify { action: "heal" } — are in the merged table but are not
      // advertised, and a closed surface has no dispatch hatch to reach them, so naming them here
      // hands the reader a four-step recipe of which one step works. Replaying flows that already
      // exist is reachable either way, via reticle_verify, so that half is still offered.
      (callable === undefined
        ? ' To make a verification REUSABLE (record once, replay free forever), the flow workflow lives here: reticle_record{action:"start"} → act → reticle_flow_save → reticle_verify{action:"flows"} (and reticle_verify { action: "heal" } on drift). Load those names when you want to save or re-run a flow.'
        : ' Flows that already exist replay with reticle_verify { action: "flows" }. RECORDING a new one is not reachable from this surface; start the daemon with RETICLE_ADVERTISE_ALL_TOOLS=1 if you need to build one.'),
    inputSchema: toolsShape,
    handler: (_deps: ToolDeps, args: Record<string, unknown>) => {
      // The discovery tool declared one parameter and checked none, so a call that misnamed it had
      // the key dropped and came back with the WHOLE catalogue — a well-formed answer to a question
      // nobody asked, and one the caller cannot tell from the answer it wanted. Same check and same
      // wording as reticle_run's, because two spellings of one refusal is how one of them rots.
      const stray = unknownKeys(args, toolsShape);
      if (stray.length > 0) {
        return Promise.resolve({
          error: unknownParamsError(ReticleTool.TOOLS, stray),
          params: paramInfo(toolsShape),
          hint: TOOLS_ARG_HINT,
        });
      }
      const names = Array.isArray(args['names'])
        ? (args['names'] as unknown[]).filter((n): n is string => 'string' === typeof n)
        : undefined;
      if (names === undefined || 0 === names.length) {
        // The COUNT is stated, not just implied by the array length. An agent that can see 18 tools
        // has no way to know whether that is all of them; being told the registry holds more is what
        // turns "these are the tools" into "these are the tools I was shown".
        const catalog = reachable.map((t) => ({
          name: t.name,
          summary: firstSentence(t.description, CATALOGUE_SUMMARY_LENGTH),
        }));
        // Names that USED to be tools, against the call that replaces each. Instructions written
        // against an earlier release are a permanent fact of the product — `reticle_crawl` is still
        // named by guidance in the wild — and without this the catalogue is silent about them: the
        // old name is simply absent, which reads as "no such capability" rather than "renamed".
        // Reaching the new name then costs an error string, or never happens.
        const retired = retiredToolNames();
        return Promise.resolve({
          total: catalog.length,
          tools: catalog,
          retired,
          ...profileBlock,
          // Two sentences for two different surfaces, because one sentence was wrong on one of
          // them. This told every reader to "call reticle_run { tool, args }" — and on a closed
          // surface reticle_run is not advertised OR callable, so the instruction resolves to
          // "Tool reticle_run not found". It also contradicted the profile note directly above it,
          // which already said there is no dispatch hatch. An agent reading both cannot tell which
          // half of one answer to believe, and the one it acted on was the wrong one.
          next:
            callable === undefined
              ? `All ${catalog.length} tools above are callable, advertised or not. Load full params with reticle_tools { names:[…] }, then call reticle_run { tool, args }. \`retired\` maps names that are no longer tools to the call that replaced each.`
              : `All ${catalog.length} tools above are advertised and callable directly by name — there is no dispatch hatch on this surface. Load full params with reticle_tools { names:[…] }. \`retired\` maps names that are no longer tools to the call that replaced each.`,
        });
      }
      // The grammar rides ONLY on a `names:[…]` reply that asked for a tool taking a predicate, so
      // no turn pays for it in the catalog or in the advertised schema. The lean tool surface says
      // "call reticle_tools for the full field grammar of a kind"; this is where that lands.
      const carriesPredicate = names.some((n) =>
        Object.values(byName.get(n)?.inputSchema ?? {}).some((schema) => isPredicateParam(schema)),
      );
      return Promise.resolve({
        tools: names.map((n) => {
          const t = byName.get(n);
          if (t !== undefined)
            return { name: n, description: t.description, params: paramInfo(t.inputSchema) };
          // `reticle_run` has answered a merged name with its replacement for a while; the tool
          // asked to DISCOVER tools still said "unknown tool", which is the wrong answer in the one
          // place an agent goes to resolve a name it is unsure of. Same redirect, same derivation.
          const moved = mergedNameRedirect(n);
          return moved === undefined
            ? { name: n, error: 'unknown tool' }
            : {
                name: n,
                error: mergedNameMessage(n, moved),
                tool: moved.tool,
                ...(moved.action === undefined ? {} : { action: moved.action }),
              };
        }),
        ...(carriesPredicate ? { predicateGrammar: predicateGrammar() } : {}),
      });
    },
  };

  const runShape = {
    tool: z.string().describe('Tool name to invoke, e.g. reticle_network.'),
    args: z.record(z.unknown()).optional().describe('Arguments object for that tool.'),
    // Accepted AND FORWARDED, not merely tolerated. reticle_run is the only way to reach an
    // unadvertised tool, so on a machine running several projects it has to be aimable — and
    // `sessionId` is the shape an agent already uses on every other tool. Reported from the field
    // against every app it was tried on: it took this key, dropped it, resolved by the daemon's cwd
    // project, and failed with "no browser session for project X" while naming the very session it
    // had been given.
    sessionId: z
      .string()
      .optional()
      .describe(
        'Target tab for the invoked tool. Forwarded to it — an explicit args.sessionId wins.',
      ),
  };
  const reticleRun: ToolDef = {
    name: ReticleTool.RUN,
    description:
      "Invoke any Reticle tool by name (discover names/params first with reticle_tools). On an unknown tool or bad arguments it returns the available names or the tool's params, so you can correct and retry.",
    inputSchema: runShape,
    handler: async (deps: ToolDeps, args: Record<string, unknown>) => {
      // reticle_run's OWN parameters, checked first and with the same wording as the inner check.
      // It refused an unknown key inside `args` and silently dropped one beside them: an agent that
      // wrote `reticle_run { tool, args, sessionId }` — the shape it uses on every other tool — had
      // its sessionId ignored and got a confident answer about whichever session auto-selection
      // picked. Every other tool on the surface refuses this; the escape hatch has to as well.
      const strayTop = unknownKeys(args, runShape);
      if (strayTop.length > 0) {
        return {
          error: unknownParamsError(ReticleTool.RUN, strayTop),
          hint: `pass them inside args: reticle_run { tool, args: { ${strayTop.join(', ')}: … } } if the target tool declares them`,
        };
      }
      const name = 'string' === typeof args['tool'] ? args['tool'] : '';
      const given =
        'object' === typeof args['args'] && args['args'] !== null
          ? (args['args'] as Record<string, unknown>)
          : {};
      const aimed = args['sessionId'];
      const target = byName.get(name);
      if (target === undefined) {
        // A non-zero count here means our advertised surface is confusing the agent — it reached for
        // something it believed existed. That is a docs/naming defect, and it was invisible.
        //
        // The NAME goes with it: the count says the surface confused someone, the name says which
        // capability they expected. It was already in hand here and thrown away, so the one place
        // the product could learn what agents want was discarding it. Safe — a name from our own
        // tool namespace, never app data.
        getSessionMetrics().recordUnknownTool(name);
        // ...and for 22 of those names the capability DOES exist, it just moved when tools merged.
        // Answering "unknown tool" there is simply wrong; see merged-name-redirect.
        const moved = mergedNameRedirect(name);
        if (moved !== undefined) {
          return {
            error: mergedNameMessage(name, moved),
            tool: moved.tool,
            ...(moved.action === undefined ? {} : { action: moved.action }),
          };
        }
        return { error: `unknown tool '${name}'`, available: reachable.map((t) => t.name) };
      }
      // The outer aim, forwarded ONLY to a tool that declares a session — injecting it into one that
      // does not would trip the unknown-key check below and refuse a call the caller got right. An
      // inner args.sessionId wins as the more specific instruction, and an absent aim stays absent so
      // auto-selection still applies.
      const callArgs =
        'string' === typeof aimed &&
        given['sessionId'] === undefined &&
        undefined !== target.inputSchema['sessionId']
          ? { ...given, sessionId: aimed }
          : given;
      // The escape hatch is where a typo is MOST likely, because an unadvertised tool's parameters
      // are not in front of the agent at all — and it is the one path the SDK's own validation never
      // sees, since `reticle_run`'s own args (`tool`, `args`) are perfectly valid. Left unchecked,
      // `reticle_run { tool: "reticle_clock", args: { action: "freeze" } }` returned
      // `{"frozen":false}`: a well-formed answer to a question nobody asked.
      const unknown = unknownKeys(callArgs, target.inputSchema);
      if (unknown.length > 0) {
        return {
          error: unknownParamsError(name, unknown),
          tool: name,
          params: paramInfo(target.inputSchema),
          ...(target.example === undefined ? {} : { example: target.example }),
          hint: 'fix the arguments and call reticle_run again',
        };
      }
      try {
        return await runTool(target, deps, callArgs);
      } catch (error) {
        // The SAME payload the direct tool path builds — recovery included. Answering every failure
        // with "fix the arguments" threw that away, and under the default profile nearly every tool
        // is reached through here: a stale ref, a paused session, a missing pairing token all came
        // back as the agent's arguments being wrong, which is advice that spends the retry.
        const message = error instanceof Error ? error.message : String(error);
        return { ...takeVersionSkewOnto(buildErrorPayload(message)), tool: name };
      }
    },
  };

  // The server instructions say, verbatim, "reticle_tools lists it, reticle_run calls it" — naming
  // these two meta-tools as reachable through EACH OTHER, same as everything else on the surface.
  // `byName` was built from `allTools` before either was constructed, so it never held them:
  // `reticle_run { tool: "reticle_tools" }` — the exact discovery path the instructions document —
  // answered "unknown tool 'reticle_tools'" (#876). Registered here, after both exist, so the
  // dispatch this closure reads from (`byName.get`, evaluated lazily on each call) can find them.
  byName.set(ReticleTool.TOOLS, reticleTools);
  byName.set(ReticleTool.RUN, reticleRun);

  return [reticleTools, reticleRun];
}
