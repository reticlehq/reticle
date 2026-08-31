import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectSize } from '@reticlehq/core';
import { profileProject, projectAgeWeeks, sizeBucket, isMonorepo } from './project-profile.js';
import { forgeOf, gitFacts, normalizeGitOrigin } from './git-facts.js';
import { knownCommand, UNKNOWN_COMMAND } from '../cli/cli-parse.js';

const withTempProject = (build: (root: string) => void, assert: (root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), 'reticle-profile-'));
  try {
    build(root);
    assert(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe('project profiling', () => {
  it.each([
    [10, ProjectSize.TINY],
    [200, ProjectSize.SMALL],
    [900, ProjectSize.MEDIUM],
    [4000, ProjectSize.LARGE],
    [20000, ProjectSize.HUGE],
  ])('buckets %i source files as %s', (files, expected) => {
    expect(sizeBucket(files)).toBe(expected);
  });

  /**
   * featureDepth is the activation metric: forty saved flows with visual baselines and a checked-in
   * contract is a different company from two snapshot calls, and a DAU chart cannot tell them apart.
   */
  it('reports which feature families a project actually adopted', () => {
    withTempProject(
      (root) => {
        const reticle = join(root, '.reticle');
        mkdirSync(join(reticle, 'flows'), { recursive: true });
        mkdirSync(join(reticle, 'visual'), { recursive: true });
        writeFileSync(join(reticle, 'flows', 'checkout.json'), '{}');
        writeFileSync(join(reticle, 'visual', 'home.png'), '');
        // A diff is OUTPUT, not a baseline — counting it would double every visual user.
        writeFileSync(join(reticle, 'visual', 'home.diff.png'), '');
        writeFileSync(join(reticle, 'contract.json'), '{}');
      },
      (root) => {
        const profile = profileProject(root, Date.now());
        expect(profile.flowCount).toBe(1);
        expect(profile.visualBaselineCount).toBe(1);
        expect(profile.hasContract).toBe(true);
        expect(profile.featuresUsed).toContain('deterministic_replay');
        expect(profile.featuresUsed).toContain('visual_baseline');
        expect(profile.featuresUsed).toContain('capability_contract');
        expect(profile.featureDepth).toBeGreaterThan(0);
        expect(profile.featureDepth).toBeLessThan(1);
      },
    );
  });

  it('profiles a project that has never used Reticle as depth zero, not as an error', () => {
    withTempProject(
      () => {},
      (root) => {
        const profile = profileProject(root, Date.now());
        expect(profile.featureDepth).toBe(0);
        expect(profile.featuresUsed).toEqual([]);
        expect(profile.flowCount).toBe(0);
        expect(profile.stack).toBeUndefined();
        expect(profile.unknownStackReason).toBe('no_manifest');
      },
    );
  });

  it('profiles a project with unrecognised dependencies with unknownStackReason unrecognized_deps', () => {
    withTempProject(
      (root) => writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { express: '^4.18.0' } })),
      (root) => {
        const profile = profileProject(root, Date.now());
        expect(profile.stack).toBeUndefined();
        expect(profile.unknownStackReason).toBe('unrecognized_deps');
      },
    );
  });

  it('detects a monorepo from either workspaces field', () => {
    withTempProject(
      (root) => writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['a'] })),
      (root) => expect(isMonorepo(root)).toBe(true),
    );
    withTempProject(
      (root) => writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - a'),
      (root) => expect(isMonorepo(root)).toBe(true),
    );
  });

  it('reports project age in whole WEEKS — a precise date plus a stack narrows to one repo', () => {
    const now = 1_700_000_000_000;
    const threeWeeksAgo = Math.floor((now - 21 * 24 * 60 * 60 * 1000) / 1000);
    const reflog = `0000 abcd Ada <a@b.c> ${threeWeeksAgo} +0000\tcommit (initial)`;
    expect(projectAgeWeeks('/p', now, () => reflog)).toBe(3);
  });

  it('returns no age rather than guessing when there is no git history', () => {
    expect(
      projectAgeWeeks('/p', Date.now(), () => {
        throw new Error('ENOENT');
      }),
    ).toBeUndefined();
  });
});

describe('project identity from the git origin', () => {
  /**
   * The same repo cloned by four teammates used to count as four projects, because the fingerprint
   * hashed the cwd. Normalizing the origin first is what makes a real project count once.
   */
  it.each([
    'git@github.com:Acme/Web.git',
    'https://github.com/acme/web',
    'https://user:token@github.com/Acme/Web.git',
    'ssh://git@github.com/acme/web.git/',
  ])('normalizes %s to one identity', (url) => {
    expect(normalizeGitOrigin(url)).toBe('github.com/acme/web');
  });

  it('does not collapse genuinely different repos', () => {
    expect(normalizeGitOrigin('git@github.com:acme/web.git')).not.toBe(
      normalizeGitOrigin('git@github.com:acme/api.git'),
    );
  });
});

describe('git facts — what makes "users per project" answerable, or honestly unanswerable', () => {
  const config = (origin?: string): string =>
    [
      '[core]',
      '\trepositoryformatversion = 0',
      ...(origin === undefined ? [] : ['[remote "origin"]', `\turl = ${origin}`]),
    ].join('\n');

  it('reports no git when there is no .git anywhere above the project', () => {
    expect(
      gitFacts(
        '/p/q',
        () => '',
        () => false,
      ),
    ).toEqual({ state: 'none' });
  });

  /**
   * The important case. An unpushed repo has nothing shared to hash, so its projectId falls back to
   * the directory path and two teammates look like two projects. Reporting `local_only` is what lets
   * the analytics exclude those rows instead of letting them drag "users per project" toward 1.
   */
  it("reports local_only for a repo that was init'd but never pushed", () => {
    const facts = gitFacts(
      '/p',
      () => config(),
      (path) => path.endsWith('.git'),
    );
    expect(facts.state).toBe('local_only');
    expect(facts.origin).toBeUndefined();
  });

  it('reports remote plus a normalized origin once there is somewhere to push to', () => {
    const facts = gitFacts(
      '/p',
      () => config('git@github.com:Acme/Web.git'),
      (p) => p.endsWith('.git'),
    );
    expect(facts.state).toBe('remote');
    expect(facts.origin).toBe('github.com/acme/web');
    expect(facts.forge).toBe('github');
  });

  it('finds the repo from a nested subdirectory, like a monorepo package', () => {
    const facts = gitFacts(
      '/p/packages/web',
      () => config('git@github.com:a/b.git'),
      // Normalised: gitFacts walks with join(), which is backslashes on Windows, so a literal
      // POSIX compare never matched and the walk 'found' nothing. Same fixture bug as three other
      // packages.
      (path) => '/p/.git' === path.replace(/\\/g, '/'),
    );
    expect(facts.state).toBe('remote');
  });

  it.each([
    ['github.com/acme/web', 'github'],
    ['gitlab.com/acme/web', 'gitlab'],
    ['bitbucket.org/acme/web', 'bitbucket'],
    ['ssh.dev.azure.com/acme/web', 'azure'],
  ])('buckets %s as %s', (origin, forge) => {
    expect(forgeOf(origin)).toBe(forge);
  });

  /**
   * An internal git host is usually `git.<company>.com`, so reporting the hostname would identify the
   * company outright — exactly the covert identification the policy promises not to do. The bucket
   * still carries the signal worth having: self-hosted git is a strong enterprise tell.
   */
  it('never reports the hostname of a private git host, only that it is self-hosted', () => {
    expect(forgeOf('git.acme-internal.com/platform/web')).toBe('self_hosted');
    expect(forgeOf('git.acme-internal.com/platform/web')).not.toContain('acme');
  });
});

describe('the CLI command vocabulary', () => {
  it('reports commands we know by name', () => {
    expect(knownCommand('verify')).toBe('verify');
    expect(knownCommand('gate')).toBe('gate');
  });

  /**
   * A typo can be a path, a URL, or a flow name. Echoing an unrecognized first argument would put
   * whatever someone mistyped on the wire, so the vocabulary is closed and everything else is
   * `unknown`.
   */
  it('never echoes an argument it does not recognize', () => {
    expect(knownCommand('/Users/ada/secret-app')).toBe(UNKNOWN_COMMAND);
    expect(knownCommand('statsu')).toBe(UNKNOWN_COMMAND);
  });

  it('treats a bare `reticle` as help', () => {
    expect(knownCommand(undefined)).toBe('help');
  });
});
