/**
 * Every `reticle_*` name in the agent-facing docs must be a real tool or a real event.
 *
 * A name that does not exist is not a typo here, it is a trap. agent-cheatsheet.md documented an
 * `assert-net` annotation kind that was never implemented: an agent following that advice got
 * `annotate_unknown_kind`, its annotation was dropped, and the flow stayed presence-only — able to
 * pass while broken, silently. SKILL.md separately told agents to look for two proxy events that had
 * been renamed, and docs/debugging.md named a `reticle_journal` tool that has never existed.
 *
 * Four ghosts across three files, found by a person running the fixtures by hand. This is the cheap
 * check that would have found them: the docs are a contract with the agent, and a contract that
 * names something imaginary is worse than one that says nothing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ReticleTool, FlowStepTool } from '@reticlehq/core';
import { REPO_ROOT } from '../../machine/repo-root.js';
import { CORE_TOOL_NAMES, defaultAdvertisedNames } from './tool-surface.js';

const REPO = REPO_ROOT;
/** The docs an AGENT is pointed at. Internal design notes are not a contract with anyone. */
const AGENT_DOCS = [
  'SKILL.md',
  // The setup half of SKILL.md, split out so an already-installed agent stops paying to read it.
  // Same audience and the same rules apply, so it is checked the same way.
  'docs/skill-setup.md',
  'docs/agent-cheatsheet.md',
  'docs/debugging.md',
  'docs/usage.md',
  // Every published skill. These are the files a user PASTES into their agent, so they are the most
  // agent-facing documents in the repository — and they were not checked here at all, which is how
  // five call-shaped examples of tools that are not advertised came to ship. `plugin/SKILL.md` is
  // the marketplace copy of the root skill and travels the same way.
  ...readdirSync(join(REPO_ROOT, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join('skills', entry.name, 'SKILL.md')),
  'plugin/SKILL.md',
];

/**
 * The tools an agent is handed directly, so a bare `name({...})` in a doc is a call it can make.
 *
 * Everything else exists but is NOT advertised, and reaching it takes one `reticle_run` hop. The
 * root SKILL.md states that rule explicitly and follows it; the `skills/` directory did not, and a
 * skill that shows `reticle_clock({ ... })` as a bare call sends the reader to a tool that is not
 * on their list. That is worse than saying nothing, and the repo's own tool-surface comment says
 * why: a tool an agent must already know about is a tool that never gets called.
 */
const ADVERTISED: ReadonlySet<string> = new Set([
  /*
   * The LIVE default surface first, then the wider table.
   *
   * `CORE_TOOL_NAMES` alone stopped describing what a reader is handed when the nine became the
   * default: `reticle_look` is advertised there and absent from that list, so a doc showing the
   * correct call was reported as sending readers to a tool they do not have. Both are kept, because
   * this guard asks "could a reader make this call" across the surfaces the docs serve, and a name
   * on either is a name somebody can reach.
   */
  ...defaultAdvertisedNames(),
  ...CORE_TOOL_NAMES,
  ReticleTool.RUN,
  ReticleTool.TOOLS,
  ReticleTool.VERIFY,
  FlowStepTool.ACT,
  FlowStepTool.ACT_SEQUENCE,
  FlowStepTool.ACT_AND_WAIT,
]);

/** Every `reticle_*` identifier we actually ship: tool names, plus every event any source emits. */
function shippedNames(): Set<string> {
  const names = new Set<string>(Object.values(ReticleTool));
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      for (const m of readFileSync(path, 'utf8').matchAll(/['"`](reticle_[a-z0-9_]+)['"`]/g)) {
        names.add(m[1] as string);
      }
    }
  };
  walk(join(REPO, 'server', 'src'));
  walk(join(REPO, 'adapters', 'realm', 'dom', 'src'));
  walk(join(REPO, 'core', 'src'));
  return names;
}

describe('agent-facing docs name only things that exist', () => {
  const shipped = shippedNames();
  for (const doc of AGENT_DOCS) {
    it(`${doc} has no ghost reticle_* names`, () => {
      let text: string;
      try {
        text = readFileSync(join(REPO, doc), 'utf8');
      } catch {
        return; // a doc that does not exist cannot mislead anyone
      }
      const ghosts = [
        ...new Set([...text.matchAll(/`(reticle_[a-z0-9_]+)`/g)].map((m) => m[1] as string)),
      ].filter((name) => !shipped.has(name));
      expect(ghosts, `named in ${doc} but shipped nowhere`).toEqual([]);
    });

    it(`${doc} shows no bare call to an unadvertised tool`, () => {
      let text: string;
      try {
        text = readFileSync(join(REPO, doc), 'utf8');
      } catch {
        return;
      }
      const bare: string[] = [];
      text.split('\n').forEach((line, i) => {
        // A `reticle_run({ tool: "x" })` on the line IS the supported shape, so the line is fine.
        if (/reticle_run\s*\(/.test(line)) return;
        for (const m of line.matchAll(/(?<!["'`\w])(reticle_[a-z0-9_]+)\s*\(/g)) {
          const name = m[1] as string;
          if (!ADVERTISED.has(name)) bare.push(`${doc}:${i + 1} ${name}`);
        }
      });
      expect(
        bare,
        'shown as a direct call, but not on the advertised tool list — an agent reading this ' +
          'cannot make that call. Write it as reticle_run({ tool: "…", args: { … } }), which is ' +
          'the supported shape rather than a workaround.',
      ).toEqual([]);
    });
  }
});
