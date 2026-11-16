import * as z from 'zod';
// Plain constants live in a zod-free module, so the SDK reads them without zod (#2369).
import { ChannelId } from './channel-id.js';
// Plain constants live in a zod-free module, so the SDK reads them without zod (#2369).
import { Independence, Grade } from './channel-id.js';

/**
 * Where evidence comes from, and whether it is allowed to count.
 *
 * This is the load-bearing wall of the protocol. Every other verification format in existence
 * records WHAT was observed and, at best, where it came from. None of them records whether the
 * observation was CAUSED BY the thing it is being offered as evidence for -- and without that, an
 * application's own report of its own success is evidence with impeccable provenance.
 *
 * The rule is one sentence: **evidence for a consequence must not come from the channel that
 * performed the action.** Click a button, and the same click handler tells you it worked: you have
 * learned that the handler ran. You have not learned that anything happened.
 *
 * It has an exact precedent outside software, and the precedent cost lives. Two-of-three sensor
 * voting is a correct doctrine, and MCAS implemented it over a single angle-of-attack vane. The
 * doctrine was right; nothing in the system knew that the votes were not independent. A protocol
 * that states the rule in prose and does not let an implementation DECLARE independence has built
 * the same aeroplane.
 */

/**
 * A channel id as a REALM may declare one: named by this specification, or somebody's extension.
 *
 * `ChannelId` is the closed list of nine this document names, and it stays closed -- that is what
 * makes `CHANNEL_DEFAULTS` a `Record` the compiler can check. But a realm is explicitly allowed to
 * observe channels this specification does not name, and until this type existed the permission
 * reached the SCHEMAS and stopped at the type system: anything typed `ChannelId` refused an `x-`
 * name outright.
 *
 * The cost was exact rather than theoretical. A realm whose primary channel is an extension could
 * declare it, validate it, and then express no criterion that reads it, because the language layer
 * types `reads` and `channels`. The first such realm is a command-line tool, whose consequence is
 * a file on disk and whose name for that is `x-artifact`; the protocol's own extension mechanism
 * would have refused the first subject that needed it.
 *
 * Deliberately NOT used for `CHANNEL_DEFAULTS`, which answers for the nine and must not pretend to
 * answer for a name it has never seen.
 */
export type DeclaredChannelId = ChannelId | `x-${string}`;

export const ChannelIdSchema = z.union([
  z.nativeEnum(ChannelId),
  z
    .string()
    .regex(/^x-[a-z0-9-]+$/, 'a channel this specification does not name must start with x-'),
]);

/**
 * One channel an implementation declares at connect time.
 *
 * The declaration is itself the first assertion, and it is checkable before any action is spent: a
 * claim that reads a channel nobody declared is `unknown` at once, rather than after the moment
 * has passed. "Nothing was watching" and "it did not happen" produce the same empty evidence and
 * mean opposite things; an implementation that reports them alike has produced its first false
 * verdict before it observed anything.
 */
export const ChannelDescriptorSchema = z.object({
  id: ChannelIdSchema,
  independence: z.nativeEnum(Independence),
  grade: z.nativeEnum(Grade),
  /** What this channel actually watches here, for a human deciding whether to trust it. */
  note: z.string().optional(),
});
export type ChannelDescriptor = z.infer<typeof ChannelDescriptorSchema>;
