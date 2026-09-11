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
import { CORE_TOOL_NAMES } from './tool-surface.js';
import { TOOLS } from './tools.js';

const CHEATSHEET = join(import.meta.dirname, '../../../../docs/agent-cheatsheet.md');
const doc = readFileSync(CHEATSHEET, 'utf8');
/** The "Core tool set" section, up to the paragraph that starts listing the non-core ones. */
const coreSection = doc.slice(doc.indexOf('## Core tool set'), doc.indexOf('Frequently useful'));

describe('the agent cheat-sheet describes the surface that actually ships', () => {
  it('names every core tool in its core list', () => {
    // Backtick-delimited, like the overclaim check below: a bare `includes` is satisfied by a LONGER
    // name that contains this one, so dropping `reticle_act` while keeping `reticle_act_and_wait`
    // passed a gate whose entire job was to notice a core tool going missing from the doc.
    const missing = [...CORE_TOOL_NAMES].filter(
      (name) => !new RegExp(`\`${name}\``).test(coreSection),
    );
    expect(missing).toEqual([]);
  });

  it('claims nothing is core that is not', () => {
    const overclaimed = TOOLS.map((t) => t.name)
      .filter((name) => !CORE_TOOL_NAMES.has(name))
      // `reticle_act` is a substring of `reticle_act_and_wait`; match on a word boundary.
      .filter((name) => new RegExp(`\`${name}\``).test(coreSection));
    expect(overclaimed).toEqual([]);
  });

  // The doc's PROFILE SIZES are gated in profile-sizes.test.ts, over both this file and SKILL.md —
  // the counts belong next to the numbers they are derived from, and pinning a phrase here as well
  // meant two gates disagreeing about which count ("46 tools" or "48 advertised") the doc must state.
});
