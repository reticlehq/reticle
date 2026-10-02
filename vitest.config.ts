import { defineConfig, configDefaults } from 'vitest/config';
import { sharedTestOptions } from './vitest.shared.js';

/**
 * Agent git worktrees are full copies of the tree. A root `vitest run` that does not
 * exclude them collects their tests and reports those branches' failures as this checkout's.
 * `pnpm test:unit` never hits this — turbo scopes per package — which is why it stayed hidden.
 */
export const AGENT_WORKTREE_GLOBS = ['**/.claude/worktrees/**', '**/.cursor/worktrees/**'] as const;

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ...AGENT_WORKTREE_GLOBS],
    // Reaches the packages that have NO config of their own — `next` and `babel-plugin` — because
    // vitest walks up to this one for them. A package WITH a local config does not inherit any of
    // this, which is why all ten of those spread the same options explicitly.
    ...sharedTestOptions,
  },
});
