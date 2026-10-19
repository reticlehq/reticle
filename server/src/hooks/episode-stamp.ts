/**
 * Which episode a run belongs to, the commit it ran against, and the agent session behind it.
 *
 * The episode log notes each episode here as it writes; the run store reads it back to stamp a run
 * with `episodeId`, `agentSession` and `project.commit`, so a run joins to the agent's trajectory
 * exactly instead of by time and file. A leaf: it imports nothing, so both sides can reach it.
 */

export interface EpisodeStamp {
  episodeId: string;
  /** The git HEAD at the episode's start, once git has answered. */
  head?: string;
  /**
   * The coding agent's own session id, as its MCP server announced it (Claude Code's
   * `CLAUDE_CODE_SESSION_ID`, which is the `session_id` its hooks receive). Names the
   * `agent-<session>.jsonl` the agent hooks write.
   */
  agentSession?: string;
}

interface Noted extends EpisodeStamp {
  /** The tabs this episode's calls drove, and the order of its last call to each. */
  tabs: Map<string, number>;
}

/** Per project root, each episode by id. */
const byRoot = new Map<string, Map<string, Noted>>();
/** Orders calls across episodes, so "the last episode to drive a tab" is well defined. */
let tick = 0;

/** What one write to an episode says. Every field may be absent: a HEAD arrives later, alone. */
export interface EpisodeNote {
  head?: string;
  sessionId?: string;
  agentSession?: string;
}

/** An episode wrote to `root`. */
export function noteEpisode(root: string, episodeId: string, note: EpisodeNote = {}): void {
  const episodes = byRoot.get(root) ?? new Map<string, Noted>();
  const known = episodes.get(episodeId) ?? { episodeId, tabs: new Map<string, number>() };
  if (note.head !== undefined) known.head = note.head;
  if (note.agentSession !== undefined) known.agentSession = note.agentSession;
  if (note.sessionId !== undefined) known.tabs.set(note.sessionId, (tick += 1));
  episodes.set(episodeId, known);
  byRoot.set(root, episodes);
}

const stampOf = ({ episodeId, head, agentSession }: Noted): EpisodeStamp => ({
  episodeId,
  ...(head === undefined ? {} : { head }),
  ...(agentSession === undefined ? {} : { agentSession }),
});

/**
 * The episode a run written to `root` belongs to: the calling connection's; else, outside a call,
 * the one whose calls last drove the run's tab; else the project's only episode. Two episodes and
 * nothing to tell them apart is undefined, never the newest one.
 */
export function episodeStampFor(
  root: string,
  attachId?: string,
  sessionId?: string,
): EpisodeStamp | undefined {
  const episodes = byRoot.get(root);
  if (episodes === undefined) return undefined;
  const own = attachId === undefined ? undefined : episodes.get(attachId);
  if (own !== undefined) return stampOf(own);
  if (sessionId !== undefined) {
    let driver: Noted | undefined;
    for (const episode of episodes.values()) {
      const at = episode.tabs.get(sessionId);
      if (at !== undefined && (driver === undefined || at > (driver.tabs.get(sessionId) ?? 0)))
        driver = episode;
    }
    if (driver !== undefined) return stampOf(driver);
  }
  const [only, ...more] = episodes.values();
  return only !== undefined && 0 === more.length ? stampOf(only) : undefined;
}
