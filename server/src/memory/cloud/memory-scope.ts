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
 * ## Why the envelope, and not the entries
 *
 * Sending `projectId` is the fix, and it only works once the platform filters on it. Against a server
 * that does not know the parameter yet, the client would go on being handed the whole workspace and
 * would report it as this project's knowledge — the same lie, now with a parameter in the URL that
 * makes it look handled. So the response is checked here too, and WHERE it is checked is the lesson:
 * the platform puts the project id on the response ENVELOPE — `{ projectId, entries }` — and not on
 * each entry. An entry-level filter therefore matched nothing, kept everything, and read as a fix
 * while being none. `scopeOfMemoryResponse` reads the envelope and refuses the whole response when
 * it names another project, or names none.
 *
 * The entry-level filter stays as a second pass. It is redundant against the platform's real shape,
 * and it is the right answer against a server that labels entries instead — cheap to keep, and
 * nothing here rests on it.
 *
 * ## Every reader, and that word is load-bearing
 *
 * Three callers read this endpoint: the `reticle_memory` tool, flow replay's automatic consultation,
 * and `reticle memory` at a terminal. The first cut gave the first two an entry-level filter and the
 * third the parameter alone, while a comment claimed all three were covered — and none of the three
 * was, because the project id arrives on the envelope. They now share `scopedMemoryEntries`, so a
 * fourth reader cannot get a different answer than the other three.
 *
 * Lives beside `cloud-sync.ts` rather than in `recall/` because that is where the other platform path
 * constants live, and because both readers already reach this directory: a home under `recall/` would
 * make `flows` reach a directory it never needed.
 */

/**
 * The path this module builds, spelled once, for the same reason as the names below.
 *
 * Here rather than in `cloud-sync.ts`'s group of `CLOUD_*_PATH` constants: that group describes the
 * calls THAT file makes, and cloud-sync has no memory reader at all. Adding this one there would make
 * the group a registry of every endpoint in the package rather than a description of one file's calls.
 */
const CLOUD_MEMORY_PATH = '/v1/memory';

/**
 * The wire names, spelled once.
 *
 * `PROJECT_ID` is a request parameter AND a response field. They are the same word on purpose — the
 * server echoes back what it was asked about — and one constant keeps a rename from moving only one
 * of the two, which would silently restore the unfiltered read. `SUBJECT` is a request parameter only
 * and is named for the same reason: it is a spelling the platform owns, not ours.
 */
export const MemoryScopeField = {
  PROJECT_ID: 'projectId',
  SUBJECT: 'subject',
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
  if (scope.subject !== undefined) {
    parts.push(`${MemoryScopeField.SUBJECT}=${encodeURIComponent(scope.subject)}`);
  }
  const projectId = projectToName(scope.projectId);
  if (projectId !== undefined) {
    parts.push(`${MemoryScopeField.PROJECT_ID}=${encodeURIComponent(projectId)}`);
  }
  const url = `${baseUrl}${CLOUD_MEMORY_PATH}`;
  return 0 === parts.length ? url : `${url}?${parts.join('&')}`;
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

/**
 * Whether a memory response can be read as THIS project's knowledge.
 *
 * The platform puts the project id on the response ENVELOPE, not on each entry (see the module note).
 * Reading it there is the only check that works against the real shape: an entry-level filter sees no
 * project field at all and keeps everything, so a server that ignores the request parameter — or
 * resolves the key to a different project — hands back a whole workspace under this project's
 * heading with nothing to distinguish it.
 */
export const MemoryResponseScope = {
  /** The envelope names the project this read asked about. Its entries may be read. */
  OWN: 'own',
  /** The envelope names a DIFFERENT project. Nothing in it belongs to this one. */
  OTHER: 'other',
  /**
   * The envelope does not say which project it is about — an older server, or a shape we do not
   * know. Unverifiable, which is NOT the same as empty and must not be shown as though it were.
   */
  UNSCOPED: 'unscoped',
  /**
   * This read named no project to begin with, so there is nothing for the envelope to contradict.
   * The env-credential path with no `cloud.json`: CI, and a single-project setup that never linked.
   */
  NOT_ASKED: 'not-asked',
} as const;
export type MemoryResponseScope = (typeof MemoryResponseScope)[keyof typeof MemoryResponseScope];

/** The two verdicts that permit reading the entries. Named so no caller re-derives the pair. */
export const isReadableMemoryScope = (scope: MemoryResponseScope): boolean =>
  MemoryResponseScope.OWN === scope || MemoryResponseScope.NOT_ASKED === scope;

/**
 * What the envelope says about which project this response is about.
 *
 * A missing or non-string field is `UNSCOPED` rather than a mismatch: the wire is somebody else's
 * server, and "this response never said" is a different fact from "this response named a rival".
 * Both refuse; only the message a reader shows differs.
 */
export function scopeOfMemoryResponse(
  body: unknown,
  projectId: string | null | undefined,
): MemoryResponseScope {
  const mine = projectToName(projectId);
  if (mine === undefined) return MemoryResponseScope.NOT_ASKED;
  if (null === body || 'object' !== typeof body) return MemoryResponseScope.UNSCOPED;
  const stated = (body as Record<string, unknown>)[MemoryScopeField.PROJECT_ID];
  if ('string' !== typeof stated || 0 === stated.length) return MemoryResponseScope.UNSCOPED;
  return stated === mine ? MemoryResponseScope.OWN : MemoryResponseScope.OTHER;
}

/**
 * The entries a reader may treat as this project's, or `undefined` when the response cannot be read
 * that way at all.
 *
 * `undefined` is the point of the return type. Three callers need three different sentences and none
 * of them is a list: the tool reports `UNVERIFIED`, the CLI refuses out loud, and replay attaches
 * nothing. "This project knows nothing" and "the server answered about something else" are different
 * facts, and only the first is safe to act on.
 */
export function scopedMemoryEntries(
  body: unknown,
  projectId: string | null | undefined,
): unknown[] | undefined {
  if (!isReadableMemoryScope(scopeOfMemoryResponse(body, projectId))) return undefined;
  if (null === body || 'object' !== typeof body) return undefined;
  const entries = (body as Record<string, unknown>)['entries'];
  if (!Array.isArray(entries)) return undefined;
  return keepOwnProject(entries, projectId);
}

/**
 * The same filter, for a caller that prints the server's envelope rather than reading a list.
 *
 * `reticle memory` writes the response to stdout as JSON, so filtering has to preserve every other
 * field the server sent and replace only `entries`.
 *
 * ONLY call this once `scopeOfMemoryResponse` has said the envelope is readable — it filters entries
 * and cannot refuse a response, so on an unverified body it would print the very thing that must not
 * be printed. A body whose `entries` is not an array is handed back untouched: at that point the
 * envelope has already been accepted, and guessing further is how a diagnostic command starts
 * dropping the thing it was asked to print.
 */
export function scopeMemoryResponse(body: unknown, projectId: string | null | undefined): unknown {
  if (null === body || 'object' !== typeof body) return body;
  const envelope = body as Record<string, unknown>;
  const entries = envelope['entries'];
  if (!Array.isArray(entries)) return body;
  return { ...envelope, entries: keepOwnProject(entries, projectId) };
}
