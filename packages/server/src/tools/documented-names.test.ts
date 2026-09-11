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
import { ReticleTool } from './tool-names.js';

const REPO = join(import.meta.dirname, '..', '..', '..', '..');
/** The docs an AGENT is pointed at. Internal design notes are not a contract with anyone. */
const AGENT_DOCS = ['SKILL.md', 'docs/agent-cheatsheet.md', 'docs/debugging.md', 'docs/usage.md'];

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
  walk(join(REPO, 'packages', 'server', 'src'));
  walk(join(REPO, 'packages', 'browser', 'src'));
  walk(join(REPO, 'packages', 'core', 'src'));
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
  }
});
