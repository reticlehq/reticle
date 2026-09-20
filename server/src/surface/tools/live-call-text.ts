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
    // The backticks are part of the match, not decoration around it. The shipped constant reads
    // ``with `reticle_run { \u2026 }` (a human can equivalently run `reticle drive <url>`)``, and a
    // pattern that stopped at `}` left the closing backtick sitting between it and the parenthetical
    // \u2014 so the optional group could not match, the clause survived, and the replacement landed
    // inside the original quoting. What an agent read was the human-equivalent clause twice over,
    // with backticks nested three deep.
    pattern:
      /`?reticle_run\s*\{\s*tool:\s*\\?"reticle_lease\\?"[^}]*\}`?(\s*\([^)]*\))?(\s*[-\u2014]+\s*reticle_lease is[^.]*\.)?/g,
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
  /*
   * Saving a flow is the PAYOFF the results keep advertising, and the default surface cannot do it.
   *
   * MEASURED while driving a real install: a passing `reticle_act` answered `keep: "… keep it as a
   * regression flow with reticle_flow_save { saveAs: '<name>' }"`, and the `no-flow-intent` gap said
   * to "save it again with intent". Calling it returns "reticle_flow_save exists in this build but
   * is not reachable on this tool surface … there is no dispatch tool here to route through". Three
   * separate results told the agent to do the one thing the surface withholds.
   *
   * `explore` is the reachable equivalent: it drives and RECORDS what it drove, which is what
   * "keep this as a regression flow" was reaching for.
   */
  {
    needs: [ReticleTool.RECORD, ReticleTool.FLOW_SAVE],
    // The pair, first: rewriting the two names separately leaves "record one with X then X".
    pattern:
      /\breticle_record\b\s*(?:\{[^}]*\})?(?:\s*start\/stop)?\s*(?:and|then|→|->|,\s*then)\s*\breticle_flow_save\b\s*(?:\{[^}]*\})?/g,
    instead: 'reticle_verify { action: "explore", persona }, which drives it and records the flow',
  },
  /*
   * Kept SHORT on purpose. This lands inside tool descriptions, which are re-sent on every turn of
   * every session, and the longer two-route version cost 67 bytes there against a budget measured
   * in whole-session terms — for advice that is read once, on a first run.
   *
   * `explore` needs ANTHROPIC_API_KEY and says so itself when it is missing, naming the fallback in
   * the same breath ("flows are recorded by your own coding agent through the MCP tools"). That
   * error is now recognised as ours, so the reader who hits it gets the next step instead of an
   * invitation to file a defect report. One hop, and every hop is honest.
   */
  {
    needs: [ReticleTool.FLOW_SAVE],
    pattern: /\breticle_flow_save\b\s*(?:\{[^}]*\})?/g,
    instead: 'reticle_verify { action: "explore", persona }',
  },
  {
    needs: [ReticleTool.RECORD],
    pattern: /\breticle_record\b\s*(?:\{[^}]*\})?/g,
    instead: 'reticle_verify { action: "explore", persona }',
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
  /**
   * A sentence explaining where a name WENT keeps that name, even though it is unreachable.
   *
   * These messages open with their own subject — "reticle_act_sequence was merged into reticle_act",
   * "reticle_refresh no longer exists" — and the rewrite is precisely a rule for replacing
   * unreachable names, so it replaced the subject too. Asking about `reticle_act_sequence` answered
   * "reticle_act no longer exists", which is false: `reticle_act` is a tool, and the one thing the
   * reader needed to know was which name had moved.
   *
   * Only the leading token, and only in front of those two phrases. Every other mention in the same
   * sentence — including the tool to call INSTEAD — is still rewritten, which is the whole job.
   */
  const explainsItsSubject = /^(reticle_[a-z_]+)(?= (?:was merged into|no longer exists))/.exec(
    out,
  );
  const subject = explainsItsSubject?.[1];
  return out.replace(TOOL_TOKEN, (name, offset: number) => {
    if (name === subject && 0 === offset) return name;
    if (advertised.has(name)) return name;
    return replacementFor(name, advertised) ?? name;
  });
}

/**
 * Keys whose STRING value names a thing rather than advising a call.
 *
 * `name` is what the caller asked about and has to match their question against; `tool` is the
 * already-resolved answer to "call this instead", so redirecting it a second time can only move it
 * away from the answer. Deliberately two names and not a pattern: every other string in a result is
 * prose, and prose is exactly what the rewrite is for.
 */
const IDENTITY_KEYS: ReadonlySet<string> = new Set(['name', 'tool']);

/**
 * The same rewrite, applied to a result's STRING VALUES instead of to its encoded form.
 *
 * This exists because the encoded form was the wrong place. The replacements above contain double
 * quotes -- `reticle_verify { action: "flows" }` -- and splicing those into serialised JSON leaves
 * them unescaped, so the payload stops parsing. MEASURED: three e2e specs that pass on the parent
 * commit went red, each reporting an EMPTY session list, because the sessions diagnostic names
 * `reticle_flow` and the rewrite broke the envelope around the data it was describing. The advice
 * was corrected and the result became unreadable, which is a worse trade than the advice was worth.
 *
 * Values, not keys: a key is a contract with the caller and nothing in a key is advice.
 *
 * And not every value is advice either. A field that carries a tool's IDENTITY is an answer to
 * "which one", not a suggestion about what to call — rewriting it destroys the thing the caller
 * asked for. `reticle_tools { names: ["reticle_act_sequence"] }` sets `name` to the name it was
 * asked about, and this rewrote it to `reticle_act`, so a batch query came back with entries the
 * caller could no longer match to their questions. See `IDENTITY_KEYS`.
 */
export function liveCallValues(value: unknown, advertised: ReadonlySet<string>): unknown {
  if ('string' === typeof value) return liveCallText(value, advertised);
  if (Array.isArray(value)) return value.map((each) => liveCallValues(each, advertised));
  if (null !== value && 'object' === typeof value) {
    const out: Record<string, unknown> = {};
    for (const [key, each] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        IDENTITY_KEYS.has(key) && 'string' === typeof each
          ? each
          : liveCallValues(each, advertised);
    }
    return out;
  }
  return value;
}
