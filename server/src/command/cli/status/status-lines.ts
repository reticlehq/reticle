/**
 * `reticle status`, rendered for a person.
 *
 * The command printed one line of JSON and nothing else. Its own source called it "the second-most
 * run command and the one a HUMAN types" — and the answer to that human was
 * `{"t":"…","event":"reticle_status","port":4400,"running":true,…}`. It is worse than that now that
 * agents run it: an agent's terminal output is read by the person sitting behind it, so a machine
 * line is a line two readers have to decode and only one of them can.
 *
 * The JSON stays, unchanged, on stderr — it is documented, and it is what a log is for. This is the
 * same facts on stdout, in the shape `doctor` already uses, so the two commands read as one tool.
 *
 * Pure, and tolerant: it is handed the very object the log line is built from, narrows it without
 * trusting it, and prints what it can recognise. A status that cannot be rendered must still be
 * logged, so nothing here may throw.
 */

/** Every row label this block can print. The one spelling; nothing writes a label inline. */
export const StatusLabel = {
  DAEMON: 'daemon',
  SESSIONS: 'sessions',
  AGENT_LINK: 'agent link',
  NEXT: 'next',
  SPLIT_BRAIN: 'split brain',
  UPDATE: 'update',
} as const;
export type StatusLabel = (typeof StatusLabel)[keyof typeof StatusLabel];

const LABELS: readonly StatusLabel[] = Object.values(StatusLabel);

/** The heading, so a reader can tell which command produced the block. */
const HEADING = 'reticle status';
const INDENT = '  ';
/** Padded off the longest label, for the same reason `doctor` does it: the column IS the legibility. */
const LABEL_COLUMN = LABELS.reduce((widest, l) => Math.max(widest, l.length), 0) + 2;

const OK = '✓';
const NOT_OK = '✗';

function row(label: StatusLabel, rest: string): string {
  return `${INDENT}${label.padEnd(LABEL_COLUMN)}${rest}`;
}

/** A continuation line under a row: indented past the label column, carrying no label of its own. */
function continuation(rest: string): string {
  return `${INDENT}${' '.repeat(LABEL_COLUMN)}${rest}`;
}

function str(fields: Record<string, unknown>, key: string): string | undefined {
  const v = fields[key];
  return 'string' === typeof v && v.length > 0 ? v : undefined;
}

function num(fields: Record<string, unknown>, key: string): number | undefined {
  const v = fields[key];
  return 'number' === typeof v ? v : undefined;
}

/** The session facts worth a line. Anything else stays in the JSON. */
interface SessionView {
  readonly url: string;
  readonly notes: readonly string[];
}

function sessionViews(fields: Record<string, unknown>): SessionView[] {
  const raw = fields['sessions'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((s): SessionView[] => {
    if ('object' !== typeof s || null === s) return [];
    const r = s as Record<string, unknown>;
    // Each of these explains something a reader would otherwise call a bug: a throttled or hidden
    // tab answers slowly, a stale one answers about a page that has moved on, and an unresponsive
    // one does not answer at all.
    const notes = [
      true === r['throttled'] ? 'throttled' : undefined,
      true === r['hidden'] ? 'hidden' : undefined,
      true === r['stale'] ? 'stale' : undefined,
      true === r['unresponsive'] ? 'unresponsive' : undefined,
    ].filter((n): n is string => n !== undefined);
    return [{ url: str(r, 'url') ?? '(no url reported)', notes }];
  });
}

/** The block to print on stdout, one string per line, heading first. */
export function statusLines(fields: Record<string, unknown>): string[] {
  const port = num(fields, 'port');
  const at = port === undefined ? '' : ` on :${String(port)}`;
  const pid = num(fields, 'pid');
  const running = true === fields['running'];

  const lines = [HEADING];

  lines.push(
    row(
      StatusLabel.DAEMON,
      running
        ? `${OK} running${at}${pid === undefined ? '' : ` (pid ${String(pid)})`}`
        : `${NOT_OK} not running${at}`,
    ),
  );
  // What was actually ON the port, when the pid file said nothing useful. "A stranger holds this"
  // and "nothing is here" were the same output once, and the true sentence was said by nothing a
  // person sees — so the word belongs in the prose, not only in the event.
  const presence = str(fields, 'presence');
  if (presence !== undefined) lines.push(continuation(`port presence: ${presence}`));
  // The refusal a FOREIGN port produces. It is the whole answer when it is present, so it rides the
  // daemon row rather than waiting for a `next` that is not built in that branch.
  const reason = str(fields, 'reason');
  if (reason !== undefined) lines.push(continuation(reason));

  if (running) {
    const count = num(fields, 'sessionCount') ?? 0;
    lines.push(
      row(
        StatusLabel.SESSIONS,
        count > 0
          ? `${OK} ${String(count)} page${1 === count ? '' : 's'} connected`
          : `${NOT_OK} no page connected`,
      ),
    );
    for (const s of sessionViews(fields)) {
      lines.push(
        continuation(`${s.url}${0 === s.notes.length ? '' : `  (${s.notes.join(', ')})`}`),
      );
    }
    // The daemon's own explanation for an empty session list, which outranks anything this command
    // could infer — it is the one holding the connection.
    const why = str(fields, 'why');
    if (why !== undefined) lines.push(continuation(why));
  }

  const client = str(fields, 'mcpClient');
  if (client !== undefined) lines.push(row(StatusLabel.AGENT_LINK, client));

  for (const [label, key] of [
    [StatusLabel.NEXT, 'nextAction'],
    [StatusLabel.SPLIT_BRAIN, 'splitBrain'],
    [StatusLabel.UPDATE, 'updateAvailable'],
  ] as const) {
    const value = str(fields, key);
    if (value !== undefined) lines.push(row(label, value));
  }

  return lines;
}
