import { describe, expect, it } from 'vitest';
import {
  PROJECT_REGISTRY_FILE,
  ProjectRegistrySchema,
  emptyProjectRegistry,
  projectCandidates,
  rememberProject,
} from './project-registry.js';

/**
 * The registry exists for the case config discovery cannot reach: a daemon running in one repo while
 * the app under test lives in a different one. Discovery walks out from the daemon's own directory,
 * so it never finds a sibling checkout — and that is the shape a user-scoped MCP registration
 * produces by default, because the editor starts the daemon wherever it likes.
 *
 * `init` knows both halves at the moment it runs: the directory it is initialising and the projectId
 * it just wrote. Recording that pair once makes every later session resolvable from anywhere on the
 * machine, with no wire change and no protocol negotiation.
 */

describe('project registry', () => {
  it('is a single well-known file, so writer and reader cannot drift', () => {
    expect(PROJECT_REGISTRY_FILE).toBe('projects.json');
  });

  it('remembers a project by id, with the directory it lives in', () => {
    const after = rememberProject(
      emptyProjectRegistry(),
      'acme-web-9f3c1d',
      '/repo/apps/web',
      1000,
    );
    expect(after.projects['acme-web-9f3c1d']).toEqual({
      directory: '/repo/apps/web',
      lastSeenAt: 1000,
    });
  });

  /**
   * A project that moved — renamed, re-cloned, moved to another disk — must not leave the old path
   * behind as a second answer. Latest write wins, keyed on the id.
   */
  it('replaces the directory when a known project is seen somewhere new', () => {
    const first = rememberProject(emptyProjectRegistry(), 'acme-9f3c', '/old/path', 1000);
    const second = rememberProject(first, 'acme-9f3c', '/new/path', 2000);
    expect(Object.keys(second.projects)).toEqual(['acme-9f3c']);
    expect(second.projects['acme-9f3c']?.directory).toBe('/new/path');
    expect(second.projects['acme-9f3c']?.lastSeenAt).toBe(2000);
  });

  it('does not mutate the registry it was given', () => {
    const before = emptyProjectRegistry();
    rememberProject(before, 'acme-9f3c', '/repo', 1000);
    expect(before.projects).toEqual({});
  });

  it('keeps other projects untouched', () => {
    let reg = emptyProjectRegistry();
    reg = rememberProject(reg, 'a-1', '/a', 1000);
    reg = rememberProject(reg, 'b-2', '/b', 2000);
    expect(projectCandidates(reg)).toEqual([
      { projectId: 'a-1', directory: '/a' },
      { projectId: 'b-2', directory: '/b' },
    ]);
  });

  /**
   * The candidate shape is deliberately the same one config discovery produces, so the resolver
   * takes both sources through one code path and neither becomes privileged.
   */
  it('produces candidates in the shape the resolver already consumes', () => {
    const reg = rememberProject(emptyProjectRegistry(), 'acme-9f3c', '/repo/apps/web', 1000);
    const [candidate] = projectCandidates(reg);
    expect(candidate).toEqual({ projectId: 'acme-9f3c', directory: '/repo/apps/web' });
  });

  it('refuses an entry with an empty id or directory rather than storing a useless row', () => {
    const reg = emptyProjectRegistry();
    expect(rememberProject(reg, '', '/repo', 1000).projects).toEqual({});
    expect(rememberProject(reg, 'acme-9f3c', '', 1000).projects).toEqual({});
  });

  /**
   * The file is written by one process and read by another, so a half-written or hand-edited file is
   * reachable. Parsing must fail closed to "we know nothing" — a registry that throws would take the
   * daemon down over a cache.
   */
  it('parses a well-formed file', () => {
    const parsed = ProjectRegistrySchema.safeParse({
      version: 1,
      projects: { 'acme-9f3c': { directory: '/repo', lastSeenAt: 1000 } },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a malformed file instead of half-reading it', () => {
    expect(ProjectRegistrySchema.safeParse({ version: 1, projects: { a: {} } }).success).toBe(
      false,
    );
    expect(ProjectRegistrySchema.safeParse({ projects: {} }).success).toBe(false);
    expect(ProjectRegistrySchema.safeParse('nonsense').success).toBe(false);
  });
});
