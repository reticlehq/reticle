/**
 * Types for `sync-skill.mjs`. This file lets a TypeScript guard import the generator.
 */

/** One generated copy of the skill. */
export interface SkillCopy {
  path: string;
  name: string;
  description: string;
  homepage: string;
  source: string;
  internal: boolean;
  /** Pin the `init` command to the release version, as the plugin pins its daemon. */
  pinInit?: boolean;
}

/** Every generated copy, in the order the generator writes them. */
export const SKILL_COPIES: readonly SkillCopy[];

/** The expected text of every copy, keyed by its repository path. */
export function syncSkill(root?: string): Map<string, string>;
