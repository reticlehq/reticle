/**
 * The agent cheat-sheet is documentation an agent ACTS on, so a wrong line there is a wrong tool
 * call — not a typo.
 *
 * Measured against the shipped surface, it named 41 tools where there are 46, and its "Core tool
 * set" listed five tools that are not in `core` (reticle_domain, reticle_capabilities,
 * reticle_baseline, reticle_project, reticle_session) while omitting four that are — including
 * reticle_inspect, the one that turns a finding into a file:line. An agent reading it reached for
 * tools the default profile does not advertise, and never reached for the ones it does.
 *
 * Prose cannot import a constant, so this test is the seam: the doc has to keep saying what the code
 * actually does.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_TOOL_NAMES, defaultAdvertisedNames } from './tool-surface.js';
import { TOOLS } from './tools.js';
import { REPO_ROOT } from '@/machine/repo-root.js';

const CHEATSHEET = join(REPO_ROOT, 'docs/agent-cheatsheet.md');
const doc = readFileSync(CHEATSHEET, 'utf8');
/**
 * The "Core tool set" section: what the doc presents as CALLABLE, and nothing after it.
 *
 * Both boundaries are asserted below rather than trusted. This used to end at the literal
 * 'Frequently useful', and when that paragraph was reworded `indexOf` returned -1, `slice` ran to
 * the end of the file, and the section silently became the whole document — which made the
 * overclaim check start flagging tools the doc names precisely to say they are NOT callable. A
 * missing boundary must narrow to nothing and fail, never widen to everything and mean something
 * else.
 */
const SECTION_START = '## Core tool set';
const SECTION_END = 'Not on this surface at all';
const coreSection = doc.slice(doc.indexOf(SECTION_START), doc.indexOf(SECTION_END));

describe('the agent cheat-sheet describes the surface that actually ships', () => {
  it('finds the section at all, so the checks below are about real text', () => {
    expect(
      doc.indexOf(SECTION_START),
      `${SECTION_START} is gone from the cheat-sheet`,
    ).toBeGreaterThan(-1);
    expect(doc.indexOf(SECTION_END), `${SECTION_END} is gone from the cheat-sheet`).toBeGreaterThan(
      -1,
    );
    expect(coreSection.length).toBeGreaterThan(200);
  });

  /*
   * ADVERTISED, not `CORE_TOOL_NAMES`.
   *
   * This asked for all seventeen core names until the merged nine became the default, at which
   * point it was pinning the doc to a surface no agent is given. It went red when the cheat-sheet
   * was corrected to say `reticle_look { action: "page" }` in place of `reticle_snapshot` — the doc
   * getting MORE accurate. A guard whose premise has gone stale does not fail quietly; it fails
   * against the fix.
   */
  it('names every tool an agent is actually shown', () => {
    // Opening backtick only: the doc writes `reticle_look { action: "page" }`, so the name is not
    // the whole of what sits between the backticks. A bare `includes` would be satisfied by a
    // LONGER name containing this one, which is how dropping `reticle_act` while keeping
    // `reticle_act_and_wait` once passed a gate meant to notice exactly that.
    const missing = [...defaultAdvertisedNames()].filter(
      (name) => !new RegExp('`' + name).test(coreSection),
    );
    expect(missing).toEqual([]);
  });

  it('presents no tool as core that an agent cannot call', () => {
    const advertised = new Set(defaultAdvertisedNames());
    const overclaimed = TOOLS.map((t) => t.name)
      .filter((name) => !advertised.has(name) && !CORE_TOOL_NAMES.has(name))
      .filter((name) => new RegExp('`' + name + '`').test(coreSection));
    expect(overclaimed).toEqual([]);
  });

  // The doc's PROFILE SIZES are gated in profile-sizes.test.ts, over both this file and SKILL.md —
  // the counts belong next to the numbers they are derived from, and pinning a phrase here as well
  // meant two gates disagreeing about which count ("46 tools" or "48 advertised") the doc must state.
});
