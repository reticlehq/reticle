/**
 * Tabs that are connected, and that are not the project making this call (#2492).
 *
 * An id-less call refuses them. That refusal stays. The session list used to leave them in the
 * same array as this project's tabs and say nothing, so a page reached through a port forward
 * looked missing. The list names them here, with the url and the project root.
 */
import { basename, dirname } from 'node:path';
import { z } from 'zod';
import { ReticleDir } from '@reticlehq/core';
import { callingClientDirectory } from '@/hooks/client-directory.js';
import { readProjectId } from '@/command/cli/ports/resolve/cli-port.js';
import { isUnmatchedRoot } from '@/memory/project/dir/reticle-dir.js';

/** The field on a session-list result that carries tabs from another project. */
export const OUTSIDE_PROJECT_FIELD = 'outside';

/** The heading of that section. One spelling, so the list and its test cannot drift. */
export const OUTSIDE_PROJECT_HEADING = 'connected, outside this project';

/** What the list needs from a connected tab to decide whether it is outside this project. */
export interface OutsideSessionSource {
  id: string;
  url: string;
  projectId?: string | undefined;
  /** The directory the page reported. Wins over the evidence folder. */
  projectRoot?: string | undefined;
  /** The `.reticle` directory this tab's evidence was filed under, when one was chosen. */
  artifactRoot?: string | undefined;
}

interface OutsideRow {
  sessionId: string;
  url: string;
  projectId: string;
  projectRoot?: string;
}

/** Declared so a schema-aware client does not strip the section. */
export const OUTSIDE_PROJECT_OUTPUT = {
  [OUTSIDE_PROJECT_FIELD]: z
    .object({
      heading: z.literal(OUTSIDE_PROJECT_HEADING),
      sessions: z.array(
        z.object({
          sessionId: z.string(),
          url: z.string(),
          projectId: z.string(),
          projectRoot: z
            .string()
            .optional()
            .describe(
              'The project directory. The page reported it, or the evidence is filed under it. It may not exist on this machine.',
            ),
        }),
      ),
    })
    .optional()
    .describe(
      'Present when a tab is connected but it is not this project. The url and project root name it. Pass its sessionId to drive it. An id-less call still refuses it.',
    ),
};

/**
 * The project directory to show for one tab.
 *
 * The page's own report wins. Otherwise the parent of a real `.reticle` folder. An unmatched
 * bucket is this daemon's filing place, not the project's directory, so it is not a root.
 */
export function projectRootOf(session: OutsideSessionSource): string | undefined {
  if (session.projectRoot !== undefined && session.projectRoot.length > 0) {
    return session.projectRoot;
  }
  const artifact = session.artifactRoot;
  if (artifact === undefined || isUnmatchedRoot(artifact)) {
    return undefined;
  }
  if (basename(artifact) !== ReticleDir.ROOT) {
    return undefined;
  }
  return dirname(artifact);
}

/**
 * The outside-project section, or undefined when every connected tab is this project.
 *
 * No caller directory, or a directory with no project id, has nothing to be outside of.
 */
export function outsideProjectSection(
  sessions: readonly OutsideSessionSource[],
): { heading: typeof OUTSIDE_PROJECT_HEADING; sessions: OutsideRow[] } | undefined {
  const dir = callingClientDirectory();
  if (dir === undefined) {
    return undefined;
  }
  const callerProjectId = readProjectId(dir);
  if (callerProjectId === undefined) {
    return undefined;
  }
  const rows: OutsideRow[] = [];
  for (const session of sessions) {
    if (session.projectId === undefined || session.projectId === callerProjectId) {
      continue;
    }
    const projectRoot = projectRootOf(session);
    rows.push({
      sessionId: session.id,
      url: session.url,
      projectId: session.projectId,
      ...(projectRoot === undefined ? {} : { projectRoot }),
    });
  }
  if (0 === rows.length) {
    return undefined;
  }
  return { heading: OUTSIDE_PROJECT_HEADING, sessions: rows };
}
