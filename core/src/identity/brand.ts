/**
 * Opaque/branded primitive types — give domain strings (and numbers) a NOMINAL type so a value can only
 * be passed where that exact kind is expected. A plain `string` runId and a `string` flowName are
 * interchangeable to the compiler and get swapped by accident (both feed path helpers!); a branded
 * `RunId` vs `FlowName` cannot. This complements the "no free strings" rule (named constants for the
 * allowed *set*) with type safety for the *values* that travel.
 *
 * Pattern:
 * export type RunId = Brand<string, 'RunId'>;
 * export const asRunId = (s: string): RunId => s as RunId; // mint at a trusted/validated boundary
 * The brand is a phantom (erased at runtime) — `RunId` is just a string at runtime, free to serialize.
 * Mint ONLY after validation (e.g. behind a `(s): s is RunId` guard) so a branded value is also a valid
 * one. Zod-validated fields use `z.string.brand<'X'>` instead, so the schema is the single source.
 */

declare const brand: unique symbol;

/** A nominal wrapper: `T` tagged with brand `B`, assignable FROM nowhere except an explicit mint/cast. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/**
 * A flow name that has passed the path-segment guard.
 *
 * The doc above names this exact hazard — "a plain `string` runId and a `string` flowName are
 * interchangeable to the compiler and get swapped by accident (both feed path helpers!)" — and for a
 * long time only RunId was branded, so the pair the warning describes was half-fixed. `flowPath` and
 * `runPath` sit beside each other and take the same shape; the compiler could not tell them apart.
 *
 * Both halves now carry it, along with `sessionDirPath` and the two journal path helpers under it.
 * The last gap was not a missing brand but a discarded one: `RunStore.list()` already returned
 * `RunId[]`, and a local `Array<{ id: string }>` annotation threw it away three lines before the
 * value reached `runPath`. A brand is only worth the weakest annotation between its mint and its
 * use — so `driveFlowName` and `isValidSessionId` now hand back the branded type directly, rather
 * than a `string` each caller has to re-bless.
 */
export type FlowName = Brand<string, 'FlowName'>;

/**
 * A session id that has passed the path-segment guard. Joined straight into journal paths, so the same
 * argument applies. Mint ONLY through the validating guard, never with a bare cast.
 */
export type SessionId = Brand<string, 'SessionId'>;

/**
 * A live element handle (`e42`) minted by the browser's ref registry.
 *
 * The most-passed identifier in the codebase and the one crossing browser↔bridge↔agent most often. The
 * registry keys a plain `Map<string, WeakRef<Element>>`, so handing it a sessionId returns null — a
 * silent miss rather than an error. Branding stops OUR code confusing the two; a ref arriving from the
 * wire is still an untrusted string until the registry resolves it.
 */
export type Ref = Brand<string, 'Ref'>;

/** Mint a Ref — the registry does this when it hands out a handle. */
export const asRef = (value: string): Ref => value as Ref;

/** Mint a FlowName — call ONLY behind isValidFlowName, or on a literal in a test. */
export const asFlowName = (value: string): FlowName => value as FlowName;
/** Mint a SessionId — call ONLY behind isValidSessionId, or on a literal in a test. */
export const asSessionId = (value: string): SessionId => value as SessionId;

/**
 * The stable build-stamped identity of an APP (`acme-web-9f3c1d`) — the one path identifier that
 * had no brand.
 *
 * The incident shape: `sessionRoot(deps, sessionId)` and `rootForProjectId(deps, projectId)` sit
 * two lines apart with the SAME signature (`(ToolDeps, string | undefined) => string`), so swapping
 * the arguments compiles. Neither then throws. `sessionRoot` given a projectId asks the session
 * manager for a session by that name, gets a throw, catches it and answers the daemon root;
 * `rootForProjectId` given a sessionId matches no candidate, resolves `NO_MATCH` and answers the
 * daemon root. No error, no log — artifacts land in a directory belonging to whichever tree the
 * daemon was launched in, and the tool reports success. That is the same silent-wrong-root family
 * `artifact-root-resolver` was written to end, arriving through the type system instead of the
 * filesystem.
 *
 * ASYMMETRY — read this before trusting it. Branding `ProjectId` alone closes ONE direction:
 *
 *   - CAUGHT: a plain-`string` sessionId passed where a `ProjectId` is expected. `string` is not
 *     assignable to `ProjectId`, so `rootForProjectId(deps, sessionId)` is a compile error. This is
 *     the dangerous direction, because it is the one that silently writes to the wrong project.
 *   - NOT CAUGHT: a `ProjectId` passed where a `sessionId` is expected. `ProjectId` IS assignable to
 *     `string`, so `sessionRoot(deps, projectId)` still compiles. It fails safe-ish — the lookup
 *     throws, is caught, and the caller gets the daemon root — but it is not a compile error.
 *
 * The line is drawn there because closing the second direction means branding `sessionId` at every
 * tool-call boundary where it arrives as a raw `unknown` argument off the wire, which is a much
 * larger change than this one. Stating it is the point: a half-closed door that claims to be shut
 * is worse than one labelled honestly.
 *
 * Minted at PROVENANCE, not at validation, and that distinction is load-bearing here. A project id
 * and a session id are both single safe path segments, so `SAFE_SEGMENT_PATTERN` cannot tell them
 * apart — minting on that guard would LAUNDER a mistyped sessionId into a `ProjectId` and hand back
 * exactly the confidence this brand exists to withhold. The mints are the places a value is known to
 * be a project's id because of WHERE IT CAME FROM: the page's HELLO `projectId` field, the
 * `projectId` key of a project's own `.reticle.json`, and the names of the subdirectories under
 * `.reticle/flows/`, which the flow store is the only writer of and writes from an already-branded
 * id. `safeProjectId` stays a FILTER over an already-branded value — it decides whether an id is
 * safe on disk, never whether it is a project.
 */
export type ProjectId = Brand<string, 'ProjectId'>;

/**
 * Mint a ProjectId — call ONLY where the value's PROVENANCE says it is a project's id: the HELLO
 * message's `projectId` field, `.reticle.json`'s `projectId` key, a directory Reticle itself named
 * after one, or a literal in a test. Never on a string that merely passed a path-segment guard; see
 * the asymmetry note above.
 */
export const asProjectId = (value: string): ProjectId => value as ProjectId;
