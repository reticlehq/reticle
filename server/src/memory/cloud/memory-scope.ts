/**
 * Which project a shared-memory read is about, on the wire and in the response.
 *
 * `GET /v1/memory` used to be asked with the API key and `?subject`, and nothing else. The key covers
 * a whole workspace, and a workspace can hold more than one repo: a `cloud.json` naming project B was
 * read with a key that also reaches project A, so B's agent could be handed A's "established
 * knowledge" and never know it. Two repos, one key, and the wrong one's facts arrive looking exactly
 * like the right one's.
 *
 * The link file has always known the answer — `resolveProjectCloud` returns it as `projectId`, and
 * every reader simply did not pass it on.
 *
 * ## Why the filter as well as the parameter
 *
 * Sending `projectId` is the fix, and it only works once the platform filters on it. Against a server
 * that does not know the parameter yet, the client would go on being handed the whole workspace and
 * would report it as this project's knowledge — the same lie, now with a parameter in the URL that
 * makes it look handled. So the response is filtered here too, and the limit is stated plainly: this
 * can only drop an entry that SAYS it belongs elsewhere.
 *
 * An entry with no project field is kept. Dropping those would blank the whole corpus against every
 * server that does not send the field, trading a leak between two repos for every project reading as
 * empty — and empty is the answer that looks like a fact rather than a failure. Kept, the unfiltered
 * case is exactly the behaviour that shipped before this file existed.
 *
 * Lives beside `cloud-sync.ts` rather than in `recall/` because that is where every other platform
 * path constant lives, and because both readers already reach this directory: a home under `recall/`
 * would make `flows` reach a directory it never needed.
 */

/**
 * The wire names, spelled once.
 *
 * `PROJECT_ID` is a request parameter AND a response field. They are the same word on purpose — the
 * server echoes back what it was asked about — and one constant keeps a rename from moving only one
 * of the two, which would silently restore the unfiltered read.
 */
export const MemoryScopeField = {
  PROJECT_ID: 'projectId',
} as const;

/**
 * What a read is asked about: the linked project, and optionally one subject within it.
 *
 * `projectId` takes `null` as well as `undefined`, because that is the shape `resolveProjectCloud`
 * already answers with — "the link declared none" is one fact, and making every caller spell the
 * conversion is how a reader starts wondering whether the two spellings mean different things.
 */
export interface MemoryReadScope {
  /** The cloud project the link file names. Absent, `null` and empty all mean "no project to name". */
  projectId: string | null | undefined;
  subject?: string | undefined;
}

/**
 * The project id to name, or `undefined` when there is none.
 *
 * `null`, `undefined` and `''` all say the same thing and all arrive in practice: `resolveProjectCloud`
 * answers `null` when the link declares nothing, an absent argument is `undefined`, and a truncated
 * config gives `''`. One helper, so the URL builder and the response filter cannot disagree about
 * which of them counts as unscoped — a disagreement that would send `?projectId=` and come back
 * empty, which reads as "this project knows nothing" rather than as a bug.
 *
 * Returns the id rather than a boolean so callers get the narrowing with it. A `boolean` predicate
 * would leave `string | null | undefined` as-is and force a `String(...)` at the call site, which is
 * a cast dressed up as a conversion.
 */
const projectToName = (projectId: string | null | undefined): string | undefined =>
  'string' === typeof projectId && projectId.length > 0 ? projectId : undefined;

/**
 * The URL for one memory read.
 *
 * Encoded with `encodeURIComponent` rather than `URLSearchParams`, which spells a space `+`. Both are
 * valid in a query string and the server may accept either — but this is a URL a test asserts against
 * and a person reads in a log, and one spelling is easier to reason about than two.
 */
export function memoryReadUrl(baseUrl: string, scope: MemoryReadScope): string {
  const parts: string[] = [];
  if (scope.subject !== undefined) parts.push(`subject=${encodeURIComponent(scope.subject)}`);
  const projectId = projectToName(scope.projectId);
  if (projectId !== undefined) {
    parts.push(`${MemoryScopeField.PROJECT_ID}=${encodeURIComponent(projectId)}`);
  }
  return 0 === parts.length ? `${baseUrl}/v1/memory` : `${baseUrl}/v1/memory?${parts.join('&')}`;
}

/**
 * Drop the entries that state they belong to another project.
 *
 * The field is read defensively because the wire is somebody else's server: a number, an object or an
 * absent key all mean "this entry does not say", and only a non-empty string that disagrees is enough
 * to refuse one. See the note above for why silence is kept rather than dropped.
 */
export function keepOwnProject(
  entries: readonly unknown[],
  projectId: string | null | undefined,
): unknown[] {
  const mine = projectToName(projectId);
  if (mine === undefined) return [...entries];
  return entries.filter((entry) => {
    if (null === entry || 'object' !== typeof entry) return true;
    const stated = (entry as Record<string, unknown>)[MemoryScopeField.PROJECT_ID];
    if ('string' !== typeof stated || 0 === stated.length) return true;
    return stated === mine;
  });
}
