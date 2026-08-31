import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectStack } from './feedback-context.js';

/**
 * The stack must be detectable when the app is not in the daemon's own directory.
 *
 * `detectStack` read exactly `join(cwd, 'package.json')` and gave up. The daemon's cwd is whatever
 * the agent's client happened to launch in — usually the repo root, while the app lives in
 * `frontend/`, `web/` or a declared workspace.
 *
 * The finding that forced the fix: across every project where Reticle was demonstrably SET UP
 * (flows / contract / features present), the stack was detected on NONE of them — and on none of
 * the large repos either. The bigger and more real the repo, the more certainly we failed. That is
 * not "these are not web apps"; Reticle only works on web apps. It is a detector looking in one
 * directory.
 */
describe('detectStack finds the app when it is not in the daemon cwd', () => {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'reticle-stack-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const write = (rel: string, body: unknown): void => {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, JSON.stringify(body), 'utf8');
  };

  it('still reads the app in the cwd itself', () => {
    write('package.json', { dependencies: { next: '^15.0.0' } });
    expect(detectStack(root).stack).toBe('next');
  });

  it('finds a DECLARED workspace app one directory down', () => {
    write('package.json', { workspaces: ['frontend'] });
    write('frontend/package.json', { dependencies: { next: '^15.1.0' } });

    const got = detectStack(root);
    expect(got.stack, 'this was null for every real repo in the field').toBe('next');
    expect(got.stackMajor).toBe(15);
  });

  it('finds an app in a conventional directory that is not declared anywhere', () => {
    // The repo shape reported twice by one user: a root with no manifest and the app in frontend/.
    // A bundler dep, because that is what `looksLikeApp` (rightly) treats as evidence of an app —
    // a bare `react` dependency with no bundler is a library, not something Reticle can drive.
    write('frontend/package.json', { dependencies: { vite: '^6.0.0', react: '^19.0.0' } });
    // `react` rather than `vite`: STACK_BY_DEP is ordered, and for a Vite+React app the UI library
    // is the more useful label. What matters here is that a stack was found AT ALL.
    expect(detectStack(root).stack).toBe('react');
  });

  it('prefers the cwd when the cwd IS an app — never redirects away from the real answer', () => {
    write('package.json', { dependencies: { vite: '^6.0.0' } });
    write('frontend/package.json', { dependencies: { next: '^15.0.0' } });
    expect(detectStack(root).stack).toBe('vite');
  });

  it('finds an Angular app in a workspace', () => {
    write('package.json', { workspaces: ['apps/*'] });
    write('apps/web/package.json', { dependencies: { '@angular/core': '^18.0.0' } });
    const got = detectStack(root);
    expect(got.stack).toBe('angular');
    expect(got.stackMajor).toBe(18);
    expect(got.stackSource).toBe('workspace');
  });

  it('finds a SvelteKit app in a workspace', () => {
    write('package.json', { workspaces: ['apps/*'] });
    write('apps/web/package.json', { dependencies: { '@sveltejs/kit': '^2.0.0' } });
    const got = detectStack(root);
    expect(got.stack).toBe('sveltekit');
    expect(got.stackMajor).toBe(2);
    expect(got.stackSource).toBe('workspace');
  });

  it('reports no_manifest for a directory with no package.json anywhere', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    expect(detectStack(root)).toEqual({ unknownStackReason: 'no_manifest' });
  });

  it('reports no_dependencies when package.json has no deps', () => {
    write('package.json', { name: 'empty-app' });
    expect(detectStack(root)).toEqual({ unknownStackReason: 'no_dependencies' });
  });

  it('reports unrecognized_deps when package.json has deps not in STACK_BY_DEP', () => {
    write('package.json', { dependencies: { express: '^4.18.0' } });
    expect(detectStack(root)).toEqual({ unknownStackReason: 'unrecognized_deps' });
  });

  it('reports no_workspace_apps when monorepo declares workspaces but has no app packages', () => {
    write('package.json', { workspaces: ['packages/*'] });
    expect(detectStack(root)).toEqual({ unknownStackReason: 'no_workspace_apps' });
  });
});
