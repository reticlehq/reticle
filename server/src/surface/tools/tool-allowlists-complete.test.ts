import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReticleTool } from '@reticlehq/core';
import { RAW_TOOLS, TOOLS, MERGED_TOOLS } from './tools.js';

const SERVER_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A tool's BEHAVIOUR is declared in ten separate name sets, and forgetting one is silent.
 *
 * AGENTS.md rule 12 says "three allowlists". There are ten, and the one that matters most fails
 * without a sound: a tool missing from `VERDICT_TOOLS` emits no `verification_completed` and stops
 * counting toward the product's headline metric. Nothing throws. No test reddens. The data is simply gone — which is
 * the exact failure mode rule 10 exists to prevent and, until this file, did not.
 *
 * Two directions are checked here, and they catch different mistakes:
 *
 *   1. Every name INSIDE a set resolves to a real tool. This is the rename failure. `ReticleTool.X`
 *      is a compile error if `X` goes away, so the sets are safe against deletion — but they are
 *      NOT safe against a tool being renamed at its definition while a set keeps pointing at the
 *      old member, nor against a set naming a tool that was retired from `RAW_TOOLS` but left in
 *      the enum. Both leave a set that looks populated and matches nothing at runtime.
 *
 *   2. Every tool is a DELIBERATE member or non-member of the four behavioural sets. This is the
 *      omission failure. It is enforced by a pin: the roster below lists every tool, so a new one
 *      cannot land without a human editing this file, and the failure message says which ten
 *      sets to review. A pin is blunt, but the alternative — inferring which tools "should" produce
 *      a verdict — is a guess, and a guess is what put us here.
 *
 * This reads the sets out of SOURCE rather than importing them, because three of the riskiest
 * (`ACTION_TOOLS`, `CDP_TOOLS`, `REF_MINTING_TOOLS`) are module-private. Exporting them purely to
 * be testable would widen the package's surface to satisfy a guard, which is the wrong trade; the
 * repo already scans source this way in `e2e-surface-drift.test.ts`.
 */

/** Each behavioural set, and the file that owns it. */
const ALLOWLISTS: ReadonlyArray<{ readonly name: string; readonly file: string }> = [
  { name: 'ACTION_TOOLS', file: 'tools/tool-kit.ts' },
  { name: 'CDP_TOOLS', file: 'tools/tool-kit.ts' },
  { name: 'REF_MINTING_TOOLS', file: 'tools/tool-kit.ts' },
  { name: 'SESSION_BOUND_TOOLS', file: 'tools/tool-kit.ts' },
  { name: 'SESSION_EXEMPT_TOOLS', file: 'tools/tool-kit.ts' },
  { name: 'VERDICT_TOOLS', file: 'tools/feedback-tools.ts' },
  { name: 'CORE_TOOL_NAMES', file: 'tools/tool-surface.ts' },
  { name: 'EXTENDED_TOOL_NAMES', file: 'tools/tool-surface.ts' },
  { name: 'VERIFY_TOOL_NAMES', file: 'tools/tool-surface.ts' },
  { name: 'LEAN_TOOL_NAMES', file: 'tools/tool-surface.ts' },
];

/**
 * The `ReticleTool.X` members named inside one `new Set([...])` literal.
 *
 * Deliberately a text scan of the declaration's own bracket span rather than the whole file, so a
 * neighbouring set cannot leak members into this one's result.
 */
const membersOf = (setName: string, file: string): string[] => {
  const source = readFileSync(join(SERVER_SRC, file), 'utf8');
  const start = source.indexOf(`const ${setName}`);
  if (start < 0) return [];
  const open = source.indexOf('new Set([', start);
  if (open < 0) return [];
  const close = source.indexOf('])', open);
  if (close < 0) return [];
  return [...source.slice(open, close).matchAll(/ReticleTool\.([A-Z0-9_]+)/g)].map(
    (match) => match[1] ?? '',
  );
};

/**
 * Every tool that exists, pinned.
 *
 * Adding a tool means adding it here, and that edit is the prompt to decide its behaviour in the
 * ten sets above. Removing one means deleting its line. Neither is busywork: both are the moment
 * the decision actually gets made.
 */
const KNOWN_TOOLS: ReadonlySet<string> = new Set(Object.values(ReticleTool));

describe('tool allowlists are complete', () => {
  it.each(ALLOWLISTS)('$name names only tools that exist', ({ name, file }) => {
    const members = membersOf(name, file);

    expect(
      members.length,
      `${name} in ${file} parsed as empty — has its shape changed?`,
    ).toBeGreaterThan(0);

    const unknown = members.filter((member) => !(member in ReticleTool));
    expect(
      unknown,
      `${name} (${file}) names enum members that do not exist: ${unknown.join(', ')}`,
    ).toEqual([]);
  });

  it('every allowlisted name is a live tool, not one retired from the surface', () => {
    /**
     * The universe is RAW_TOOLS *plus* the advertised surface, because a merged family's PARENT
     * (`reticle_verify`, `reticle_session`, `reticle_flow`, `reticle_record`, `reticle_baseline`)
     * is synthesised by MERGE_PLANS and never appears in RAW_TOOLS, while its action MEMBERS do.
     * Both halves are real tools an allowlist may legitimately name.
     *
     * MERGED_TOOLS is the third: `reticle_look` is synthesised for the `merged` surface only, and
     * the behavioural allowlists (session-bound, ref-minting, captured) MUST name it — that surface
     * dispatches under it, and a missing entry there fails silently, which is the whole reason this
     * guard exists.
     */
    const live = new Set([...RAW_TOOLS, ...TOOLS, ...MERGED_TOOLS].map((tool) => tool.name));
    const enumValue = (member: string): string =>
      (ReticleTool as unknown as Record<string, string>)[member] ?? member;

    const stale = ALLOWLISTS.flatMap(({ name, file }) =>
      membersOf(name, file)
        .filter((member) => !live.has(enumValue(member)))
        .map((member) => `${name}: ${member}`),
    );

    expect(
      stale,
      'these names sit in a behavioural allowlist but no longer have a handler, so the set matches ' +
        'nothing at runtime while still looking populated:\n  ' +
        stale.join('\n  '),
    ).toEqual([]);
  });

  it('every tool in RAW_TOOLS is a known name', () => {
    const unknown = RAW_TOOLS.map((tool) => tool.name).filter((name) => !KNOWN_TOOLS.has(name));
    expect(
      unknown,
      `RAW_TOOLS carries names absent from ReticleTool: ${unknown.join(', ')}`,
    ).toEqual([]);
  });

  /**
   * The pin.
   *
   * A hard number, deliberately. The first draft of this compared `RAW_TOOLS.length` against
   * `Object.values(ReticleTool).length` — which is always true, because every tool name comes from
   * that enum. It passed, read as coverage, and proved nothing. That is the precise failure this
   * file exists to catch, so it is worth naming: a guard whose assertion cannot fail is worse than
   * no guard, because it occupies the space where a real one would go.
   */
  it('holds the tool count, so a new tool forces a review of the ten allowlists', () => {
    /*
     * 63 since `reticle_verify { action: "explore" }` — the model-driven drive.
     *
     * 64 since `reticle_verify { action: "mutate" }` — the one that grades the FLOW rather than the
     * app. Membership decided deliberately, as this guard asks:
     *
     *   CDP_TOOLS            YES — it breaks a request through the same Playwright route
     *                        `reticle_network_mock` uses, so version skew must refuse it the same way.
     *   ACTION_TOOLS         no  — it drives, and it also RESOLVES itself with its own grade, exactly
     *                        as `reticle_flow_replay` does. That set exists to catch an action left
     *                        hanging with no verdict after it, which cannot happen here.
     *   VERDICT_TOOLS        no  — and this is the one worth arguing. It produces no verdict ABOUT
     *                        THE APP: it grades a flow. Counting a mutation outcome toward
     *                        `verification_completed` would inflate the headline metric with
     *                        judgements about our own suite.
     *   SESSION_BOUND/EXEMPT neither — it is a MEMBER of the merged `reticle_verify` facade, and the
     *                        facade is what `runTool` sees. Its siblings (`flows`, `crawl`) are in
     *                        neither set for the same reason.
     *   REF_MINTING_TOOLS    no  — it hands back a grade, never a ref.
     *
     * Its membership was decided against `reticle_crawl`, the sibling it behaves exactly like: both
     * are destructive actions on the whole app reached as an action on `reticle_verify`, and both
     * belong to NONE of the ten sets. The parent carries what matters — `VERIFY` is already in
     * SESSION_BOUND_TOOLS (a drive with no live session is nothing) and in VERDICT_TOOLS, where
     * `verificationOf` still requires a verdict shape this action does not return. It saves flows;
     * the replay of those flows is what produces a verdict, and that is counted where it happens.
     */
    /*
     * 65 since `reticle_session { action: "account" }` (`reticle_account`): where the user stands
     * with Reticle. It must answer with no tab, because the agent asks it before any app is open:
     * it does, through its facade, which SESSION_EXEMPT_TOOLS already holds (a member is not a name
     * in TOOLS of its own). Every other set no: it acts on no page, mints no ref, and produces no
     * verdict.
     */
    /*
     * 66 since `reticle_map`: the App Graph folded from the project's journals. SESSION_EXEMPT_TOOLS
     * YES, because the agent asks for the map before it has opened anything, and it reads only disk
     * and the live tabs' journals. Every other set no: it acts on no page (ACTION, CDP), mints no
     * ref, and produces no verdict about the app (VERDICT: counting it would inflate the headline
     * metric with reads). On no advertised surface (CORE, EXTENDED, VERIFY, LEAN): unproven, so one
     * `reticle_run` hop like `reticle_context`, and the extended surface is at its shared cap.
     */
    const PINNED_RAW_TOOL_COUNT = 66;

    expect(
      RAW_TOOLS.length,
      "The number of tools changed. Before updating this number, decide this tool's membership in " +
        'each of the ten sets listed above — the one that fails SILENTLY is VERDICT_TOOLS (the ' +
        'tool then emits no `verification_completed` and stops counting toward the headline metric).',
    ).toBe(PINNED_RAW_TOOL_COUNT);
  });
});
