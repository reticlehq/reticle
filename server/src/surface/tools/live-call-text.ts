import { ReticleTool } from '@reticlehq/core';
import { mergedNameRedirect } from './merged-name-redirect.js';

/**
 * Rewrite advice so every tool it names is one the reader was actually given.
 *
 * `surface-vocabulary.ts` made the BRIEFING derive its tool names from the advertised set, on the
 * reasoning that naming a tool the agent lacks should be unrepresentable rather than merely tested
 * for. That reasoning stops at the briefing. Everything attached to a RESULT -- a recovery, a
 * `recommendation`, a `next_action`, a `note` -- is a static string written once, and those are
 * what an agent reads under failure, which is exactly when it can least afford a dead end.
 *
 * MEASURED on the nine-tool surface: the no-session diagnosis, the command-timeout recovery and the
 * multiple-sessions refusal all routed to `reticle_run` or `reticle_lease`, and that surface
 * advertises neither. The timeout recovery even explained that `reticle_lease` "is not advertised
 * under the default profile, so it is reached through reticle_run" -- correct about the lease,
 * wrong about the hatch, and confident enough that a reader would not think to doubt it.
 *
 * Applied at the MCP boundary rather than at each string, because the next such string is written
 * by somebody who does not know this rule exists.
 */

/**
 * Advice that cannot be rewritten, only replaced.
 *
 * A merged name has somewhere to go -- `reticle_sessions` IS `reticle_session { action: "list" }`.
 * The dispatch hatch does not: a surface that drops `reticle_run` and `reticle_lease` has no tool
 * that opens a browser, so renaming would produce a sentence that is well-formed and still a lie.
 * The CLI is the one escape hatch that survives every surface, because it is not a tool.
 */
const NO_TOOL_EQUIVALENT: readonly {
  /** Rewritten only when THIS tool is missing from the surface. */
  readonly needs: readonly string[];
  readonly pattern: RegExp;
  readonly instead: string;
}[] = [
  {
    needs: [ReticleTool.RUN, ReticleTool.LEASE],
    // `\\?"` throughout: this runs over the SERIALISED result, where every quote is escaped. The
    // first version matched only the unescaped shape, passed its unit test, and changed nothing at
    // all in the live daemon -- found by re-driving the real MCP server rather than by the suite.
    pattern:
      /reticle_run\s*\{\s*tool:\s*\\?"reticle_lease\\?"[^}]*\}(\s*\([^)]*\))?(\s*[-\u2014]+\s*reticle_lease is[^.]*\.)?/g,
    instead: 'the CLI: `reticle open <url>` (a human can equivalently run `reticle drive <url>`)',
  },
  {
    needs: [ReticleTool.LEASE],
    // The bare cross-reference, left behind once the call above is gone.
    pattern: /\breticle_lease\s*\{[^}]*\}/g,
    instead: '`reticle open <url>`',
  },
  {
    needs: [ReticleTool.FLOW],
    // Saved-flow management is not on every surface and has no CLI. `verify { action: "flows" }`
    // names every saved flow in its summary, which is what the advice was reaching for.
    pattern: /\breticle_flow\s*\{[^}]*\}/g,
    instead: 'reticle_verify { action: "flows" }, which names every saved flow',
  },
];

/** `reticle_session { action: "list" }` for a name that merged; the bare tool for one that did not. */
function replacementFor(name: string, advertised: ReadonlySet<string>): string | undefined {
  const redirect = mergedNameRedirect(name);
  if (redirect === undefined) return undefined;
  // A redirect into a tool this surface also lacks is no better than the name we started with.
  if (!advertised.has(redirect.tool)) return undefined;
  return redirect.action === undefined
    ? redirect.tool
    : `${redirect.tool} { action: "${redirect.action}" }`;
}

/** Every `reticle_*` token in a piece of prose. */
const TOOL_TOKEN = /\breticle_[a-z_]+\b/g;

/**
 * The advice, with every name the reader cannot call replaced by one they can.
 *
 * Text naming only advertised tools is returned unchanged and pays one scan.
 */
export function liveCallText(text: string, advertised: ReadonlySet<string>): string {
  // The hatch is whole-phrase, so it runs FIRST: token rewriting would otherwise strip the inner
  // `reticle_lease` and leave `reticle_run { tool: "..." }` pointing at nothing.
  let out = text;
  for (const { needs, pattern, instead } of NO_TOOL_EQUIVALENT) {
    // Gated per entry: a surface keeping `reticle_flow` but dropping `reticle_lease` should have
    // its flow advice left exactly as written.
    if (needs.every((name) => advertised.has(name))) continue;
    out = out.replace(pattern, instead);
  }
  return out.replace(TOOL_TOKEN, (name) => {
    if (advertised.has(name)) return name;
    return replacementFor(name, advertised) ?? name;
  });
}
