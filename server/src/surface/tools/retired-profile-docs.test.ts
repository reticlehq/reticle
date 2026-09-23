/**
 * A retired env var advertised as the live knob is worse than no docs: an agent follows it, gets
 * the default surface, and concludes the product is broken.
 *
 * The code retired RETICLE_TOOL_PROFILE and still maps old values so shell profiles do not break.
 * Three published pages, a StartOptions JSDoc, and the reticle_tools catalog note kept telling
 * people to set it. Nothing in CI reads the docs site, so this is the gate.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { advertisedTools } from '@/surface/mcp/mcp.js';
import { ADVERTISE_ALL_ENV, TOOL_PROFILE_ENV, TOOL_SURFACE } from './tool-surface.js';
import { TOOLS } from './tools.js';
import { REPO_ROOT } from '@/machine/repo-root.js';

const REPO = REPO_ROOT;
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

describe('retired RETICLE_TOOL_PROFILE is not advertised as the live knob', () => {
  it('docs/packages/server.mdx does not default toolProfile to the retired env and `full`', () => {
    const text = read('docs/packages/server.mdx');
    expect(text).not.toMatch(/toolProfile[\s\S]{0,80}RETICLE_TOOL_PROFILE[\s\S]{0,40}`full`/);
    expect(text).toContain(ADVERTISE_ALL_ENV);
  });

  it('docs/tools/tools-and-run.mdx does not tell agents to change the retired env', () => {
    const text = read('docs/tools/tools-and-run.mdx');
    expect(text).not.toMatch(new RegExp(`change ${TOOL_PROFILE_ENV}`));
    expect(text).toContain(ADVERTISE_ALL_ENV);
  });

  it('StartOptions.toolProfile JSDoc does not claim the retired env is the live default', () => {
    // `StartOptions` left the package barrel for its own leaf when `bridge-security` needed to name
    // it without importing the barrel that imports `bridge-security`.
    const text = read('server/src/start-options.ts');
    expect(text).not.toMatch(/Defaults to env RETICLE_TOOL_PROFILE, else 'full'/);
    expect(text).toContain(ADVERTISE_ALL_ENV);
  });
});

describe('verify busy-port docs match the three-option message', () => {
  it('docs/cli/verify.mdx does not claim a raw EADDRINUSE stack', () => {
    const text = read('docs/cli/verify.mdx');
    expect(text).not.toMatch(/EADDRINUSE/);
    expect(text).not.toMatch(/raw `Error:/);
    expect(text).toContain('RETICLE_PORT');
  });
});

/**
 * Counts in a nearby comment drifted from surface-sizes.test.ts once (extended 30 vs 29). If this
 * file restates a size, it must match the live surface; if it does not restate one, it must point
 * at the file that does.
 */
describe('unadvertised-help header stays in lockstep with the surface-size gate', () => {
  const header = (): string => {
    const text = read('server/src/surface/tools/unadvertised-help.ts');
    const cut = text.indexOf('import');
    return -1 === cut ? text : text.slice(0, cut);
  };

  it('points at surface-sizes.test.ts rather than becoming a second source of truth', () => {
    expect(header()).toContain('surface-sizes.test.ts');
  });

  /*
   * Enforces the rule the header states about itself, rather than proof-reading two spellings of a
   * restatement. Both assertions used to sit inside `if (null !== regex.exec(...))`, and the header
   * restates no number today -- so this case executed ZERO assertions, and a header claiming
   * "3 of 999 tools" passed it. Only the exact phrasing `advertises 3 of 999` was ever caught.
   *
   * Forbidding the restatement is also what the header asks for in as many words: counts live in
   * `surface-sizes.test.ts`, and repeating them here is how the two drift apart. A number that is
   * not a surface count -- the failure tally from the sweep that prompted this file -- is left
   * alone, because the vocabulary below is what makes it a COUNT CLAIM rather than a digit.
   */
  it('restates no surface count, because that is the drift this header warns about', () => {
    const text = header();
    const claims = [
      /\b\d+\s+(?:of\s+\d+\s+)?tools?\b/i,
      /\badvertises?\s+\d+/i,
      /\bextended one (?:is |has )?\d+/i,
      /\bsurface (?:is|has|shows)\s+\d+/i,
      /\b\d+\s+of\s+\d+\b/,
    ];
    const found = claims.map((re) => re.exec(text)?.[0]).filter((m) => m !== undefined);
    expect(
      found,
      'This header restates a surface count. `surface-sizes.test.ts` owns those numbers -- it is ' +
        `checked against advertisedTools() and TOOLS (today ${String(
          advertisedTools(TOOL_SURFACE.DEFAULT).length,
        )} of ${String(TOOLS.length)}, extended ${String(
          advertisedTools(TOOL_SURFACE.ALL).length,
        )}), so a copy here goes stale silently. Say WHERE the counts live, not what they are.`,
    ).toEqual([]);
  });
});
