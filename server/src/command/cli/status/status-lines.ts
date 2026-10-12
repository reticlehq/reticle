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
  ACCOUNT: 'account',
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

  // Who is signed in, and whether this repo is linked: what `whoami` used to answer. Only when the
  // caller looked, which is what the key being present means.
  if ('signedInAs' in fields) {
    const who = str(fields, 'signedInAs');
    const project = str(fields, 'linkedProject');
    // Signed in to one workspace, a repo can still send to another: say which it sends to.
    const workspace = str(fields, 'linkedWorkspace');
    // A key the platform refused at the last sync is the answer, not "not signed in": a member
    // removed from the workspace was told to connect while the key was set, and refused.
    const refused = str(fields, 'keyRefused');
    lines.push(
      row(
        StatusLabel.ACCOUNT,
        refused !== undefined
          ? `${NOT_OK} refused at the last sync: ${refused}`
          : who === undefined
            ? `${NOT_OK} not signed in`
            : `${OK} signed in as ${who}`,
      ),
    );
    const apps = appLinks(fields['workspaceApps']);
    if (project === undefined && 0 < apps.length)
      for (const { app, project: linked } of apps)
        lines.push(
          continuation(
            null === linked
              ? `${app} is not linked: run \`reticle connect\` in ${app}`
              : `${app} is linked to ${linked}`,
          ),
        );
    else
      lines.push(
        continuation(
          project === undefined
            ? 'this repo is not linked: run `reticle connect`'
            : `this repo is linked to ${project}${workspace === undefined ? '' : ` in workspace "${workspace}"`}`,
        ),
      );
  }

  const client = str(fields, 'mcpClient');
  if (client !== undefined) {
    // The state in words (`mcpClientSaid`), never the record's own name for it.
    lines.push(row(StatusLabel.AGENT_LINK, str(fields, 'mcpClientSaid') ?? client));
    const action = str(fields, 'mcpClientAction');
    if (action !== undefined) lines.push(continuation(action));
  }

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

/** A workspace root's apps and their links, read defensively off the status fields. */
function appLinks(value: unknown): { app: string; project: string | null }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw: unknown) => {
    if ('object' !== typeof raw || null === raw) return [];
    const { app, project } = raw as Record<string, unknown>;
    return 'string' === typeof app
      ? [{ app, project: 'string' === typeof project ? project : null }]
      : [];
  });
}
