import { MarkStatus, type HumanMarkData, type MarkAnchorStrategy } from '@syrin/iris-protocol';

/**
 * One human review mark: a mistake a human flagged on the running page, pinned to an element, ready
 * for the agent to drain and fix. The wire payload (HumanMarkData) plus a server-assigned id, the
 * session-relative time it landed, and its lifecycle status.
 */
export interface ReviewMark {
  id: string;
  note: string;
  /** Re-resolvable element anchor (auto-anchor string). */
  anchor: string;
  strategy: MarkAnchorStrategy;
  label?: string;
  /** Source file:line the agent should open to fix it, when the framework stamped one. */
  source?: { file: string; line: number };
  route?: string;
  /** Session-relative ms the mark was made (injected clock at the call site — never read here). */
  at: number;
  status: MarkStatus;
}

/**
 * Per-session store of human review marks (the "annotate the bug where you see it" inbox). A mark is
 * added when a HUMAN_MARK event arrives, listed by the agent via iris_review, and retired with
 * resolve() when the agent claims the fix — distinct from the live-control inbox, which is drained
 * (delivered-once) on read. Marks persist (read does not consume) so the agent can list, fix, and
 * THEN resolve, and a fix can be verified against the same mark.
 *
 * Pure in-memory state: no IO, no clock. The id is a monotonic counter (m1, m2, …) so it is
 * deterministic and never depends on Math.random/Date.now; the timestamp is passed in by the caller.
 */
/** Prefix on review-mark ids (m1, m2, …) — distinguishes them from command ids. */
const MARK_ID_PREFIX = 'm';

export class ReviewStore {
  readonly #marks: ReviewMark[] = [];
  #seq = 0;

  /** Store a new mark (status pending) stamped with the caller-supplied session-relative time. */
  add(data: HumanMarkData, at: number): ReviewMark {
    this.#seq += 1;
    const mark: ReviewMark = {
      id: `${MARK_ID_PREFIX}${String(this.#seq)}`,
      note: data.note,
      anchor: data.anchor,
      strategy: data.strategy,
      at,
      status: MarkStatus.PENDING,
    };
    if (data.label !== undefined) mark.label = data.label;
    if (data.source !== undefined) mark.source = data.source;
    if (data.route !== undefined) mark.route = data.route;
    this.#marks.push(mark);
    return mark;
  }

  /** All marks still awaiting a fix, oldest first. Reading never consumes — resolve() retires a mark. */
  pending(): ReviewMark[] {
    return this.#marks.filter((m) => m.status === MarkStatus.PENDING).map((m) => ({ ...m }));
  }

  /** Count of pending marks, for the panel badge / diagnostics. */
  pendingCount(): number {
    return this.#marks.reduce((n, m) => (m.status === MarkStatus.PENDING ? n + 1 : n), 0);
  }

  /** Full history (pending + resolved), oldest first. */
  all(): ReviewMark[] {
    return this.#marks.map((m) => ({ ...m }));
  }

  /**
   * Retire a mark the agent has fixed. Returns true on a genuine pending → resolved transition,
   * false for an unknown id or an already-resolved mark (so resolve is idempotent).
   */
  resolve(id: string): boolean {
    const mark = this.#marks.find((m) => m.id === id);
    if (mark === undefined || mark.status === MarkStatus.RESOLVED) return false;
    mark.status = MarkStatus.RESOLVED;
    return true;
  }
}
