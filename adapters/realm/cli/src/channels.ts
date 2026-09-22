import { ChannelId } from 'open-verification';

/**
 * What a command-line subject can be watched on, named for what it IS here.
 *
 * Two of these are the protocol's own channels under a local name, and two are extensions. The
 * local names exist because the mapping is not obvious and a reader should not have to rediscover
 * it: a CLI's exit code travels on the protocol's `signal` channel, because an exit status is the
 * subject announcing something about itself, which is exactly what that channel means.
 *
 * The extensions follow the `x-` rule. Neither is proposed as a named member of the protocol: that
 * needs two INDEPENDENT implementations agreeing on the meaning, and both of the ones that exist
 * today share an author.
 */
export const CliChannel = {
  /** stdout and stderr. A CLI's output is deliberate, so see `CLI_CHANNELS` for the downgrade. */
  LOG: ChannelId.LOG,
  /** The exit code the tool CHOSE. The subject announcing something about itself. */
  EXIT_STATUS: ChannelId.SIGNAL,
  /** How long it took, and whether it was still running. */
  TIME: ChannelId.TIME,
  /**
   * Termination imposed from OUTSIDE the process: a signal, an OOM kill, a supervisor.
   *
   * A separate channel from `EXIT_STATUS` and not a field on it, which is OVP-CHAN-5 applied to
   * the realm that produced the rule. The two carry opposite provenance -- one the tool chose, one
   * the kernel imposed -- and a single declaration would have to lie about one of them.
   */
  PROCESS: 'x-proc',
  /**
   * That a path exists, its size, its mtime. The filesystem decided these, not the subject.
   *
   * Phase 2. Named here so the vocabulary lives in one file rather than appearing when it is
   * first needed, which is how two spellings of one channel get into a codebase.
   */
  ARTIFACT: 'x-artifact',
  /**
   * The bytes inside a file, which the subject authored entirely.
   *
   * Split from `ARTIFACT` for the reason the protocol's own `visual` channel is actuation-derived
   * despite being observed out of process: it is the CAUSING that decides independence. The
   * filesystem decides WHETHER a write lands; nothing outside the tool decides what is in it.
   */
  ARTIFACT_CONTENT: 'x-artifact-content',
} as const;
export type CliChannel = (typeof CliChannel)[keyof typeof CliChannel];
