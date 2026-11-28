/**
 * What one step leaves behind, and what the next one needs, in a vocabulary a CLI actually has.
 *
 * The protocol carries `requires` and `ensures` and deliberately never parses them: a protocol
 * that compared them would be a protocol with an opinion about what a subject IS, which is the
 * opinion it exists not to have. Only the realm knows what its own state values mean.
 *
 * For a command-line subject they mean the workspace. A build ensures `dist/index.js`; a test run
 * requires it; a clean step requires it absent. That is the whole vocabulary, and it is small on
 * purpose -- a richer one would be this adapter inventing a state language nobody else speaks.
 */

/** What a step guarantees, or demands, about the workspace. */
export interface CliStateContract {
  /** Paths that are present. */
  readonly paths?: readonly string[];
  /** Paths that are NOT present. A different claim from presence, and not its negation. */
  readonly absent?: readonly string[];
}

/**
 * Read a contract, or decline.
 *
 * `undefined` for anything unrecognised, and that answer travels all the way out: the protocol
 * reports it as `unjudged-requirement` and forbids reading it as agreement. A realm that guessed
 * here would turn every composite into one that cannot fail.
 */
export function readContract(value: unknown): CliStateContract | undefined {
  if ('object' !== typeof value || null === value) return undefined;
  const record = value as Record<string, unknown>;
  const paths = record['paths'];
  const absent = record['absent'];
  const listed = (v: unknown): boolean =>
    undefined === v || (Array.isArray(v) && v.every((p) => 'string' === typeof p));
  if (!listed(paths) || !listed(absent)) return undefined;
  // Neither key present means this is somebody else's vocabulary, not an empty contract of ours.
  if (undefined === paths && undefined === absent) return undefined;
  return {
    ...(Array.isArray(paths) ? { paths: paths as readonly string[] } : {}),
    ...(Array.isArray(absent) ? { absent: absent as readonly string[] } : {}),
  };
}

/**
 * Does what the journey established meet what the next step declares it needs?
 *
 * A comparison of DECLARATIONS, never of the disk. This runs at typecheck time, before anything
 * has been driven, so there is no filesystem state to consult and the workspace may not exist
 * yet. A version that called `stat` would answer about the wrong moment entirely, and would pass
 * or fail depending on what a previous run happened to leave behind -- which is the shape of test
 * that only works in the order it was written.
 */
export function contractSatisfies(ensures: unknown, requires: unknown): boolean | undefined {
  const had = readContract(ensures);
  const needs = readContract(requires);
  if (undefined === had || undefined === needs) return undefined;
  const established = new Set(had.paths ?? []);
  const needsPresent = (needs.paths ?? []).every((p) => established.has(p));
  // The absence half is not the negation of the presence half: a step requiring `dist` ABSENT is
  // contradicted by a predecessor that ensures it, and satisfied by one that simply never
  // mentions it.
  const needsAbsent = (needs.absent ?? []).every((p) => !established.has(p));
  return needsPresent && needsAbsent;
}
