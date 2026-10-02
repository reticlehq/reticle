import { ReticleTool } from '@reticlehq/core';
import type { ToolDef } from './tool-kit.js';

/**
 * There is ONE tool surface. This is not a menu.
 *
 * Advertised tool DEFINITIONS are re-sent to the model on every turn, so the surface is a per-turn
 * cost that compounds across a loop, and fewer tools also makes the model wander less. What ships is
 * the verify loop (navigate→look→act→observe→assert, with direct network + console + state)
 * advertised directly, plus two meta-tools — `reticle_tools` to discover and `reticle_run` to invoke
 * — that keep every other tool exactly one call away. Nothing is unreachable; the cold tail just is
 * not re-sent every turn.
 *
 * ALL is deliberately NOT a profile: it is a verification switch, the only mode that advertises
 * `outputSchema`, which is what makes the MCP layer validate tool OUTPUT — the check that caught
 * `reticle_verify_change` returning a payload its own schema rejected. Carrying output schemas on the
 * default surface more than doubles its bytes, so it cannot be folded in, and deleting it loses that
 * defect class. So it stays, and no user is asked to pick it.
 *
 * Surface sizes are NOT quoted in comments here. They live in surface-sizes.test.ts, which reads them
 * off the real surface.
 */
export const TOOL_SURFACE = {
  /** What every user gets: the verify loop, plus the 2 meta-tools that reach everything else. */
  DEFAULT: 'default',
  /** Every tool advertised directly, WITH output schemas. A verification switch — see above. */
  ALL: 'all',
  /**
   * The smallest surface that can still produce a VERDICT: one `act_and_wait`, plus the meta-tools.
   * Not a profile — a cost switch. On the path where the caller already knows what to assert, almost
   * the entire bill is the menu rather than the answer, so the menu is the thing to cut, and the
   * assertion supplies the evidence the surface would otherwise have to go and find.
   *
   * NAMED CEILING: it drops the evidence tools, and that TRIPLES false alarms. The new ones are
   * precisely the defect classes whose evidence lives in `reticle_state`, `reticle_network` and
   * `reticle_observe` — strip the observation tools and the model stops observing, reaching for the
   * verdict without the evidence and calling a healthy build broken. Deliberately not the default;
   * the token saving does not buy that.
   */
  VERIFY: 'verify',
  /**
   * The same capabilities as `default` under ten names instead of seventeen, by merging inside the
   * core hot-set: look (snapshot/query/inspect/state), observe (observe/network/console), assert
   * (assert/wait_for), and sessions folded into session. NOTHING is dropped — every tool `default`
   * advertises stays reachable, which is the difference between this and `verify`. It is the surface
   * `resolveToolSurface` falls back to.
   *
   * NAMED CEILING: a merged tool's input schema is the UNION of its members' fields with every field
   * optional, so the model sees `by`, `value`, `ref`, `mode` and `path` on one `reticle_look` with
   * nothing saying which action takes which, and a wrong-field call VALIDATES instead of being
   * refused. Accuracy is unmeasured; a token number alone never promotes a surface.
   */
  MERGED: 'merged',
  /**
   * EXPERIMENTAL, opt-in. It keeps every observation tool and cuts the rest, because the token saving
   * and the accuracy loss recorded on VERIFY above came from two different cuts and only one of them
   * has to be paid for.
   *
   * What stays, and why each one is not a candidate for removal:
   *   SNAPSHOT / QUERY   look. Without them the agent cannot name an element it did not already know.
   *   STATE / NETWORK / CONSOLE / OBSERVE   the four evidence tools. Dropping these is the MEASURED
   *                      cause of the tripled false-alarm rate. They are the point of the profile.
   *   ACT_AND_WAIT       the only tool that acts AND returns a verdict. Omitting `until` makes it
   *                      act-then-settle, which is what `reticle_act` does, so `act` is redundant here.
   *   ASSERT             the only way to get a verdict WITHOUT acting. `act_and_wait` requires an
   *                      `action`, so this is a capability it genuinely cannot express, not a synonym.
   *
   * What goes, and what it costs (one `reticle_run` hop each — `unadvertisedToolHelp` hands the agent
   * the exact call, so a dropped name never comes back as "not found"):
   *   ACT                subsumed: `act_and_wait` with `until` omitted is act-then-settle.
   *   WAIT_FOR           subsumed: `act_and_wait { until }` takes the same PredicateSchema.
   *   ACT_SEQUENCE       batching is a cost optimisation on top of a surface built to be cheap.
   *   NAVIGATE           once per run, not once per turn — the wrong thing to pay for every turn.
   *   SESSIONS           the CLI answers this (`reticle status`) without spending any turn budget.
   *   INSPECT            fix-side, not verdict-side: it is called once a bug is FOUND, so its hop is
   *                      paid once per finding rather than once per turn. Nothing else maps a node to
   *                      a source file, which is why it is a hop and not a deletion.
   *   SESSION            the lease block and the pause hint name it in prose, which is what made it
   *                      load-bearing on the default surface. Under a trimmed surface the
   *                      unadvertised-tool help turns that into a working `reticle_run` call.
   *   FEEDBACK           NAMED CEILING: an unadvertised feedback channel collects little to nothing,
   *                      so a long-lived profile must not ship without it. Acceptable only while this
   *                      profile is opt-in; if it stops being an experiment, feedback comes back first.
   */
  LEAN: 'lean',
} as const;
export type ToolSurface = (typeof TOOL_SURFACE)[keyof typeof TOOL_SURFACE];

/**
 * The switch that turns on the full, output-schema-carrying surface. A boolean, not a menu.
 *
 * Named for what it does rather than which "profile" it selects, because the previous name invited
 * users to shop among alternatives that did not meaningfully differ.
 */
export const ADVERTISE_ALL_ENV = 'RETICLE_ADVERTISE_ALL_TOOLS';

/** Opt into the smallest verdict-capable surface. Read by the DAEMON at startup, like the others. */
const VERIFY_SURFACE_ENV = 'RETICLE_VERIFY_SURFACE';

/**
 * The retired setting, still read so nobody's shell profile breaks.
 *
 * Every value it ever accepted resolves to something sensible: `full` to the ALL surface, everything
 * else to the default. Silently honouring them would repeat the original sin, so `describeToolSurface`
 * says the setting retired and what was used instead.
 */
export const TOOL_PROFILE_ENV = 'RETICLE_TOOL_PROFILE';
const RETIRED_PROFILE_VALUES: Readonly<Record<string, ToolSurface>> = {
  full: TOOL_SURFACE.ALL,
  hybrid: TOOL_SURFACE.DEFAULT,
  core: TOOL_SURFACE.DEFAULT,
  standard: TOOL_SURFACE.DEFAULT,
  dynamic: TOOL_SURFACE.DEFAULT,
};

// The set an agent needs to verify a change end-to-end. Tool DEFINITIONS are re-sent every turn, so
// this set is a per-turn cost, and every name in it has to earn its place. Sizes and counts are
// asserted in surface-sizes.test.ts, never quoted here.
//
// Measure the wire cost with a FRESH DAEMON per reading: the setting is read by the daemon at
// startup, so a loop that reuses one daemon measures the first surface every time and looks like
// proof that the setting does nothing.
//
// Where the cost sits on the default surface: inputSchema is 76% of the payload (parameter
// descriptions are half of that), tool descriptions are 12%, outputSchema ~0 because it is dropped.
// So the next real saving is in parameter prose, not in dropping more tools.
//
// There is a floor: an 8-tool cut (dropping act/navigate/wait_for/sessions) MEASURABLY regressed
// real-agent accuracy, because the model loses scaffolding and wanders on harder flows. Direct
// network/console stay — far more discoverable than observe-with-filters, so fewer turns and better
// verdicts. A formal A/B against a leaner surface on a current model is UNRUN.
// See bench/agent-loop-and-replay.md.
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ReticleTool.SESSIONS,
  ReticleTool.NAVIGATE,
  ReticleTool.SNAPSHOT,
  ReticleTool.QUERY,
  ReticleTool.ACT,
  ReticleTool.ACT_AND_WAIT,
  // ACT_SEQUENCE is here because its absence leaves the loop it exists to collapse: a login form
  // driven one round trip at a time, a click and a fill per call, which is exactly the antipattern
  // SKILL.md warns about. Reachable only through `reticle_run`, the batching tool needs an agent that
  // already knows it exists — and a tool an agent must already know about never gets called. Same
  // argument as INSPECT and FEEDBACK below.
  ReticleTool.ACT_SEQUENCE,
  ReticleTool.OBSERVE,
  ReticleTool.NETWORK,
  ReticleTool.CONSOLE,
  ReticleTool.WAIT_FOR,
  ReticleTool.ASSERT,
  ReticleTool.STATE,
  // INSPECT is what turns a finding into an EDIT: it maps a DOM node to `src/App.tsx:104`. Finding a
  // bug is half the job; knowing which file to open is the half that makes the agent useful, and it
  // is the one capability here with no substitute in any other verification tool. One tool of schema
  // tax to close the find→fix loop is the right trade; the measured floor is about cutting to 8, not
  // about holding at 12.
  ReticleTool.INSPECT,
  // FEEDBACK is on every surface for the same reason INSPECT is, and fatally so: an unadvertised
  // feedback channel collects nothing, which is indistinguishable from not having built one. It is
  // also the cheapest tool on the surface to carry (three params), and the only one whose purpose is
  // reporting which of the others are failing.
  ReticleTool.FEEDBACK,
  // SESSION is here because the product ORDERS the agent to call it. The session lease block is
  // spliced onto the first result of every session ("call reticle_session {action:'yield'}"), and the
  // pause hint onto every refusal while a human has the session paused, where {action:"resume"} is
  // the only exit. Unadvertised, an agent that obeys gets `unknown tool` and an agent that does not
  // leaves the panel reading "live" after it stopped driving — the state the handback protocol exists
  // to prevent. The alternative, deleting the instruction from the lease and the pause hint, deletes
  // the protocol: there is nowhere else those two calls are named.
  ReticleTool.SESSION,
  // VERIFY is the only advertised tool that can CONCLUDE, and its absence was measurably the most
  // expensive thing on this surface. The cause is compositional rather than behavioural: every other
  // tool here answers "here is more to look at", and none of them can say "there is nothing more". On
  // a healthy app — which is most runs — that is a loop with no exit, and it runs to the turn cap.
  //
  // `reticle_verify` is the exit. { action: "crawl" } drives every reachable control itself and
  // reports the whole fault set in ONE call, and { action: "flows" } replays the saved flows with no
  // model in the loop at all: deterministic, no flake. Both were built and neither was reachable —
  // the "a tool an agent must already know about never gets called" argument applied to the one tool
  // that ends the loop.
  ReticleTool.VERIFY,
]);

/**
 * The extended surface: what `all` advertises BEYOND the default set.
 *
 * `all` is NOT "every tool in the registry". Cursor enforces a limit of 40 tools across every
 * connected MCP server COMBINED, so a server advertising 48 by itself can push a user's other servers
 * out or be dropped wholesale. The budget is a COUNT, so no amount of trimming parameter prose buys
 * anything back — only advertising fewer names does.
 *
 * Prose is not free elsewhere, though: most of this server's schema weight is parameter descriptions
 * rather than tool descriptions, and the whole block is re-sent every turn, multiplied by turn count
 * before one byte of evidence is counted.
 *
 * Which does NOT license trimming by eye. Those descriptions are what make a tool get called
 * correctly, and one malformed call costs a whole extra turn — more than the bytes saved. The
 * outcome to measure is turn count and error rate, not size.
 *
 * Everything omitted stays in the registry, stays catalogued by `reticle_tools`, and stays callable
 * by name through `reticle_run { tool, args }`. The cost is one discovery hop on the cold tail, which
 * is the same trade the default surface has always made, applied one level further out.
 *
 * What it costs that is NOT free: `all` is the only surface that carries `outputSchema`, which is
 * what makes the MCP layer validate tool OUTPUT — the check that once caught `reticle_verify_change`
 * returning a payload its own schema rejected. The tools left off this list no longer get that
 * validation from the wire. That defect class is now uncovered for them, and it is written down here
 * rather than discovered later.
 *
 * Chosen as the capabilities an agent plausibly reaches for once the verify loop is not enough:
 * orientation, the record/replay flow loop, visual evidence, and the three fault-injection controls.
 */
export const EXTENDED_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Demoted from the default set to make room under the count cap: it was an unproven bet that
  // orientation replaces exploratory snapshots, and an unproven entry is the one that gives way.
  // Still one `reticle_run` hop from any agent that wants it.
  ReticleTool.CAPABILITIES,
  ReticleTool.FLOW_SAVE,
  ReticleTool.FLOW_REPLAY,
  // Unproven, so it does not take a default-surface slot under the cap. Same terms as the
  // capabilities demotion: reachable in one reticle_run hop by any agent that wants it.
  ReticleTool.INTENT,
  // Same terms, plus one argument specific to it: its caller is BY CONSTRUCTION an agent that just
  // lost its context and is re-reading the tool list, so the discovery hop it costs is a call that
  // caller was already going to make. See context-tools.ts.
  ReticleTool.CONTEXT,
  ReticleTool.RECORD,
  ReticleTool.SCREENSHOT,
  ReticleTool.VISUAL_DIFF,
  ReticleTool.CLOCK,
  ReticleTool.NETWORK_MOCK,
  ReticleTool.STORAGE,
]);

/**
 * The verify surface: one acting tool that returns a verdict, plus the two meta-tools that reach
 * everything else. `act_and_wait` can resolve its own target, so no query tool is needed to name an
 * element — that round trip was half the token cost of a verification.
 */
const VERIFY_TOOL_NAMES: ReadonlySet<string> = new Set([ReticleTool.ACT_AND_WAIT]);

/**
 * The lean surface: look, observe, act-with-a-verdict, assert. Pinned by lean-surface.test.ts,
 * because an experiment whose independent variable drifts mid-flight measures nothing. Every
 * inclusion and every exclusion is argued at TOOL_SURFACE.LEAN.
 *
 * NAMED CEILING — measured against the full surface as its control on the fix-and-verify benchmark:
 * it is cheaper and less correct, fixing 3 of the 5 bugs the full surface fixes, and it produced that
 * benchmark's first FALSE GREEN. On `broken-form-validation` the lean agent edited the file, took one
 * snapshot, and ended on a hypothetical walkthrough ("spaces are trimmed, valid part is used.
 * VERDICT: FIXED") against a submit button that was still enabled for a whitespace-only service: it
 * reasoned about what its own code would now do instead of driving it.
 *
 * The other loss has the same root from the other side. On `cross-component-regression` the agent
 * spent the run calling `reticle_tools` and `reticle_run` hunting for capabilities this surface does
 * not advertise, and never fixed the bug. Strip the surface and the agent stops verifying, then
 * claims anyway — the same result the `verify` surface records from the other direction.
 *
 * So it stays opt-in and stays measured, and it does not become the default: the turns it saves are
 * worth less than a verdict that lies, because the product IS the verdict.
 */
export const LEAN_TOOL_NAMES: ReadonlySet<string> = new Set([
  ReticleTool.SNAPSHOT,
  ReticleTool.QUERY,
  ReticleTool.ACT_AND_WAIT,
  ReticleTool.ASSERT,
  ReticleTool.OBSERVE,
  ReticleTool.NETWORK,
  ReticleTool.CONSOLE,
  ReticleTool.STATE,
]);

/**
 * The `merged` surface: the default surface's capabilities under ten names.
 *
 * Derived from CORE_TOOL_NAMES rather than retyped — the members that got merged away, plus the
 * names that replaced them. Writing it out by hand is how the two lists drift and a capability
 * silently stops being advertised: `filterTools` matches by NAME, so a merged tool missing from here
 * is dropped with NO error at all, and the surface reports a token saving that is really a capability
 * loss.
 */
const MERGED_AWAY: ReadonlySet<string> = new Set([
  // Absorbed by `reticle_act`, routed on the presence of `steps` rather than on an action name.
  ReticleTool.ACT_SEQUENCE,
  // Absorbed by `reticle_session`, which is already the tool for everything that talks OUT of the
  // drive — yield, narrate, messages, review. Reporting that RETICLE failed is the same shape.
  ReticleTool.FEEDBACK,
  ReticleTool.SNAPSHOT,
  ReticleTool.QUERY,
  ReticleTool.INSPECT,
  ReticleTool.STATE,
  ReticleTool.NETWORK,
  ReticleTool.CONSOLE,
  ReticleTool.WAIT_FOR,
  ReticleTool.SESSIONS,
]);

export const MERGED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...[...CORE_TOOL_NAMES].filter((name) => !MERGED_AWAY.has(name)),
  ReticleTool.LOOK,
]);

/** Is the truthy form of a boolean env var set? `1`, `true`, `yes` — anything else is off. */
function envFlagOn(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return '1' === value || 'true' === value || 'yes' === value || 'on' === value;
}

/**
 * Which surface is live.
 *
 * `explicit` is the programmatic override (tests, `advertisedTools` callers). Otherwise the ALL
 * switch decides, and the retired setting is honoured last so an old shell profile still works.
 *
 * THE FALLBACK IS `merged`: it advertises nine tools where `default` advertises nineteen, and reaches
 * the rest of the registry the way every surface does — by name, through the meta-tool. Behind an
 * env var read by the DAEMON at startup it was unreachable in practice, because an agent exporting
 * one sees no change and has no way to tell.
 *
 * `default` is kept as a NAME so the A/B that justified `merged` can still be run — the bench arms it
 * by passing `explicit`. Accuracy outranks tokens here: a cheaper surface that verifies less is a
 * loss at any price, so the arm that proves this one does not lose accuracy stays runnable.
 */
export function resolveToolSurface(explicit?: string): ToolSurface {
  if (explicit === TOOL_SURFACE.LEAN) return TOOL_SURFACE.LEAN;
  if (explicit === TOOL_SURFACE.MERGED) return TOOL_SURFACE.MERGED;
  if (explicit === TOOL_SURFACE.VERIFY) return TOOL_SURFACE.VERIFY;
  if (explicit === TOOL_SURFACE.ALL) return TOOL_SURFACE.ALL;
  if (explicit === TOOL_SURFACE.DEFAULT) return TOOL_SURFACE.DEFAULT;
  const retiredExplicit = explicit === undefined ? undefined : RETIRED_PROFILE_VALUES[explicit];
  if (retiredExplicit !== undefined) return retiredExplicit;
  // The one LIVE value of the otherwise-retired setting. It rides there rather than on a switch of
  // its own because the experiment is an A/B between two surfaces, and a boolean cannot name an arm.
  if (TOOL_SURFACE.LEAN === process.env[TOOL_PROFILE_ENV]?.trim().toLowerCase()) {
    return TOOL_SURFACE.LEAN;
  }
  if (TOOL_SURFACE.MERGED === process.env[TOOL_PROFILE_ENV]?.trim().toLowerCase()) {
    return TOOL_SURFACE.MERGED;
  }
  if (envFlagOn(process.env[VERIFY_SURFACE_ENV])) return TOOL_SURFACE.VERIFY;
  if (envFlagOn(process.env[ADVERTISE_ALL_ENV])) return TOOL_SURFACE.ALL;
  const retiredEnv = RETIRED_PROFILE_VALUES[process.env[TOOL_PROFILE_ENV] ?? ''];
  return retiredEnv ?? TOOL_SURFACE.MERGED;
}

/** The live surface plus what chose it — see describeToolSurface. */
export interface ToolSurfaceOrigin {
  active: ToolSurface;
  source: string;
}

/**
 * Which surface is live, and what chose it.
 *
 * These settings are read by the DAEMON at startup, never by the client, so exporting one in an
 * agent's environment while a daemon is already running changes nothing at all. Documenting that is
 * not enough — a setting failing to take has to be VISIBLE, so this rides along in the reticle_tools
 * catalog.
 */
export function describeToolSurface(active: ToolSurface, requested?: string): ToolSurfaceOrigin {
  const retired = requested ?? process.env[TOOL_PROFILE_ENV];
  // `lean` is the one value of this setting that is NOT retired. Reporting it as retired would tell
  // an agent its arm did not take, which on an A/B is worse than saying nothing.
  if (TOOL_SURFACE.LEAN === active) {
    return {
      active,
      source: `${TOOL_PROFILE_ENV}=${TOOL_SURFACE.LEAN} — an EXPERIMENTAL surface under measurement; unadvertised tools stay callable via ${ReticleTool.RUN}`,
    };
  }
  if (retired !== undefined && retired in RETIRED_PROFILE_VALUES) {
    return {
      active,
      source: `${TOOL_PROFILE_ENV}=${retired} is RETIRED — there is one tool surface now; using '${active}' (set ${ADVERTISE_ALL_ENV}=1 for the full, schema-carrying surface)`,
    };
  }
  if (retired !== undefined && 0 < retired.length) {
    return {
      active,
      source: `${TOOL_PROFILE_ENV} is RETIRED and '${retired}' was never one of its values; using '${active}'`,
    };
  }
  const flag = process.env[ADVERTISE_ALL_ENV];
  if (envFlagOn(flag)) {
    return { active, source: `${ADVERTISE_ALL_ENV} set in the DAEMON's environment at startup` };
  }
  // "unset" and "set to 0" are different facts, and only one of them means "you did not ask for it".
  // Reporting the second as the first is how somebody spends an afternoon on a switch that IS being
  // read and is simply off.
  return flag === undefined || 0 === flag.length
    ? {
        active,
        source: `the one tool surface (${ADVERTISE_ALL_ENV} unset when the daemon started)`,
      }
    : { active, source: `the one tool surface (${ADVERTISE_ALL_ENV}='${flag}' is off)` };
}

/**
 * The names a daemon started RIGHT NOW advertises, meta-tools included.
 *
 * Derived, never listed: whatever `resolveToolSurface` answers is what this describes. A hardcoded
 * vocabulary is how `buildServerInstructions` came to brief every agent reaching Reticle through
 * `reticle mcp` — the proxy briefs without passing a surface — to call `reticle_snapshot`,
 * `reticle_query` and `reticle_wait_for` while being served a surface that has none of them. An agent
 * that tries a tool it was shown, fails, and tries again abandons the product. Pinned by
 * surface-coherence.test.ts.
 */
export function defaultAdvertisedNames(): readonly string[] {
  const surface = resolveToolSurface();
  const names = [...filterToolNames(surface)];
  /*
   * Both meta tools, on every surface, because that is what the MCP actually advertises.
   *
   * This used to withhold `reticle_run` from the merged surface, reasoning that "naming a hatch
   * that is not there is the same defect one level in". The reasoning is sound and the premise was
   * false: `buildDynamicTools` returns `[reticle_tools, reticle_run]` unconditionally and
   * `advertisedTools` appends both to every surface, so the hatch has always been there. Measured
   * against a live daemon on the default surface: `reticle_run` is advertised, and
   * `reticle_run { tool: "reticle_lease" }` reaches `reticle_lease`.
   *
   * Two functions answering one question, and this was the one the MCP never called. It is read by
   * `server-instructions`, which gates "Everything else is one hop: reticle_tools lists it,
   * reticle_run calls it" on this list - so agents were told the hatch was absent from a surface
   * carrying it, and six recovery messages were later rewritten to match the lie.
   * `advertised-names-are-real.test.ts` now pins this to `advertisedTools` itself.
   */
  return [...names, ReticleTool.TOOLS, ReticleTool.RUN];
}

/** The advertised NAME set for a surface, without needing the tool table. */
function filterToolNames(surface: ToolSurface): ReadonlySet<string> {
  if (surface === TOOL_SURFACE.VERIFY) return VERIFY_TOOL_NAMES;
  if (surface === TOOL_SURFACE.LEAN) return LEAN_TOOL_NAMES;
  if (surface === TOOL_SURFACE.MERGED) return MERGED_TOOL_NAMES;
  if (surface === TOOL_SURFACE.DEFAULT) return CORE_TOOL_NAMES;
  return new Set([...CORE_TOOL_NAMES, ...EXTENDED_TOOL_NAMES]);
}

export function filterTools(tools: ToolDef[], surface: ToolSurface): ToolDef[] {
  if (surface === TOOL_SURFACE.VERIFY) return tools.filter((t) => VERIFY_TOOL_NAMES.has(t.name));
  if (surface === TOOL_SURFACE.LEAN) return tools.filter((t) => LEAN_TOOL_NAMES.has(t.name));
  if (surface === TOOL_SURFACE.MERGED) {
    return tools.filter((t) => MERGED_TOOL_NAMES.has(t.name));
  }
  if (surface === TOOL_SURFACE.DEFAULT) return tools.filter((t) => CORE_TOOL_NAMES.has(t.name));
  // `all` is the extended surface, not the whole registry — the cap is a hard budget shared with
  // every other MCP server the user has connected. surface-sizes.test.ts enforces it.
  return tools.filter((t) => CORE_TOOL_NAMES.has(t.name) || EXTENDED_TOOL_NAMES.has(t.name));
}
