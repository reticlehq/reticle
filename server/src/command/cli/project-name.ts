/**
 * What project a repo binds to when nobody says.
 *
 * `link` used to answer "default" for every repo on every machine, which is wrong in two directions
 * at once. Measured: two unrelated checkouts linked on one account — a storefront and a billing
 * service — both bound to a single project called "Default" and shared one key, so their runs,
 * issues and impact merged into one bucket and the dashboard's per-project view described nothing.
 * It is also what made two TENANTS collide, because a credential slot built from a project id is
 * only as distinct as the ids are.
 *
 * A repo already knows its name: the directory it lives in. That is not a guess, it is the name its
 * owner chose and the one they will look for in a project list.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import { z } from 'zod';
import { PROJECT_ID_HASH_LENGTH } from '@reticlehq/core';
import { CredentialRefusedError, api, hint } from './cloud-kit.js';

/** Cap the slug so a deep or oddly-named checkout cannot produce an unreadable project id. */
const MAX_SLUG = 48;

/** The id used when a directory name yields nothing usable — the historical behaviour, unchanged. */
export const DEFAULT_PROJECT_ID = 'default';

/**
 * Turn a directory name into a project id: lowercase, and anything that is not a letter or digit
 * becomes a single hyphen. Conservative on purpose — this id ends up in URLs, in credential slot
 * keys and in a project list somebody has to read.
 */
export const slugifyProjectName = (raw: string): string => {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
  return 0 === slug.length ? DEFAULT_PROJECT_ID : slug;
};

/**
 * The project a `link` with no `--project` should target.
 *
 * The EXISTING binding wins over the directory name, and that ordering is the whole safety of this
 * change. A repo that is already linked has history in a project; re-running `link` — which people
 * do to rotate a key or repoint an environment — must land in that same project or the history
 * silently splits in two, which is worse than the shared-bucket problem this fixes.
 */
export const defaultProjectFor = (
  cwdBasename: string,
  existingProjectId: string | undefined,
  /** The `projectId` `init` wrote into `.reticle.json`, when there is one. */
  localProjectId?: string,
): string => {
  if (existingProjectId !== undefined && existingProjectId.length > 0) return existingProjectId;
  // The name part of `init`'s `<name>-<hash>`, else the id as written: a name the owner chose.
  const named =
    localProjectId === undefined || 0 === localProjectId.length
      ? undefined
      : (nameOfLocalId(localProjectId) ?? localProjectId);
  return slugifyProjectName(named ?? cwdBasename);
};

/** `init`'s id is the app's name and a short hash of where it lives: `nina-todo-f96721e8`. */
const LOCAL_ID = new RegExp(`^(.+)-[0-9a-f]{${String(PROJECT_ID_HASH_LENGTH)}}$`);

/**
 * The name part of the id `init` wrote. One project carried two names: `.reticle.json` said
 * `nina-todo-f96721e8` (from the package) while the dashboard said `app` (the folder), so the person
 * looked for one and the list showed the other. The dashboard now takes the name `init` wrote.
 */
function nameOfLocalId(localProjectId: string): string | undefined {
  return LOCAL_ID.exec(localProjectId)?.[1];
}

export const CreatedProjectSchema = z.object({ projectId: z.string(), name: z.string() });
const ProjectsListSchema = z.object({
  projects: z.array(
    z.object({ projectId: z.string(), name: z.string(), repo: z.string().optional() }),
  ),
});

/** ` in workspace "<name>"`, or nothing when no name is known. */
export const inWorkspace = (name: string | undefined): string =>
  name === undefined || 0 === name.length ? '' : ` in workspace "${name}"`;

/** Characters of the repository identity: enough to tell repositories apart, nothing to read. */
const REPO_ID_CHARS = 16;

/**
 * Which repository, and which folder in it, a project folder is: a hash of the `origin` remote and
 * the folder's path inside the checkout, so every clone of one app agrees and two different apps
 * both named `web` do not. Undefined outside git or with no remote. Neither leaves the machine.
 */
export function repoIdentity(dir: string): string | undefined {
  try {
    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    const remote = git('config', '--get', 'remote.origin.url')
      .replace(/\.git$/, '')
      .replace(/^[a-z+]+:\/\/|^[^@]+@/i, '')
      .replace(':', '/')
      .toLowerCase();
    if (0 === remote.length) return undefined;
    const inside = relative(git('rev-parse', '--show-toplevel'), dir).split('\\').join('/');
    return createHash('sha256')
      .update(`${remote}\u0000${inside}`)
      .digest('hex')
      .slice(0, REPO_ID_CHARS);
  } catch {
    return undefined;
  }
}

/**
 * The id for the project the caller named, creating it if it does not exist yet — and saying so,
 * in which workspace. A project of that NAME made for another repository is not reused: two apps
 * whose package is `web` shared one dashboard project. A project with no recorded repository, or an
 * id named outright, is reused as before.
 */
/** Projects named when creating one was refused. */
const MAX_NAMED = 5;

export async function resolveProjectId(
  url: string,
  token: string,
  wanted: string,
  workspace?: string,
  repo?: string,
  /**
   * The id `init` wrote into `.reticle.json`, for a project created by default: the platform is
   * asked to keep it, so the folder and the dashboard name one project by one id. A platform that
   * does not know the field ignores it and answers with its own, which is what gets linked.
   */
  localId?: string,
): Promise<string> {
  const { projects } = ProjectsListSchema.parse(await api('GET', `${url}/v1/projects`, token));
  const lc = wanted.toLowerCase();
  const holding = localId === undefined ? undefined : projects.find((p) => p.projectId === localId);
  if (holding !== undefined) return holding.projectId;
  const match = projects.find(
    (p) =>
      p.projectId === wanted ||
      (p.name.toLowerCase() === lc &&
        (repo === undefined || p.repo === undefined || p.repo === repo)),
  );
  if (match !== undefined) return match.projectId;
  let answer: unknown;
  try {
    answer = await api('POST', `${url}/v1/projects`, token, {
      name: wanted,
      ...(repo === undefined ? {} : { repo }),
      ...(localId === undefined ? {} : { projectId: localId }),
    });
  } catch (error) {
    // Refused to create one (a contributor): the platform's words, then the step that works.
    if (
      error instanceof CredentialRefusedError ||
      !(error instanceof Error) ||
      0 === projects.length
    )
      throw error;
    const names = projects.map((p) => p.name).slice(0, MAX_NAMED);
    throw new Error(
      `${error.message}\nTo link one that exists: ${names.map((n) => `\`reticle connect --project ${n}\``).join(', ')}`,
    );
  }
  const created = CreatedProjectSchema.parse(answer);
  hint(
    `created project "${wanted}" (${created.projectId})${inWorkspace(workspace)} — it did not exist yet`,
  );
  return created.projectId;
}
