/**
 * The feedback channel — the one place in Reticle that sends words someone wrote.
 *
 * Reticle is built for agents, and until now nothing closed the loop: when a tool misbehaved, or a
 * verification came back undecidable, or an observer simply could not see the thing that mattered,
 * that knowledge died in the agent's context window. This module is the return path. An agent files a
 * report through `reticle_feedback` when a tool fails it; a human files one through `reticle
 * feedback` with a rating and their own words.
 *
 * Three properties are non-negotiable here, because free text is a different privacy class from the
 * event counters the rest of telemetry sends:
 *
 *   1. NEVER PASSIVE. There is no code path that emits feedback on its own. Every event is the direct
 *      result of an explicit call someone made carrying content they authored. Nothing is scraped
 *      from the app, the DOM, the network log, or the repo.
 *   2. REDACTED BEFORE THE WIRE. `redactFeedbackText` strips the credential/PII shapes that leak into
 *      a pasted trace even when the author meant no harm. It runs client-side, so the redaction is
 *      auditable in this repo rather than promised in a policy.
 *   3. INDEPENDENTLY DISABLE-ABLE. `RETICLE_FEEDBACK=0` kills the channel while leaving anonymous
 *      adoption metrics on — the setting an org wants when counters are fine but prose is not. Every
 *      existing switch (`RETICLE_TELEMETRY=0`, `DO_NOT_TRACK`, `reticle telemetry disable`) still
 *      disables it too, since it rides the same emitter.
 */
import {
  FeedbackSchema,
  FEEDBACK_TEXT_MAX,
  FEEDBACK_TRACE_MAX,
  FEEDBACK_FIELD_MAX,
  TelemetryEventKind,
  type Feedback,
} from '@reticlehq/core/telemetry';
import { homedir, platform } from 'node:os';
import { getTelemetry, type Telemetry } from './telemetry.js';
import { noteFeedbackUndelivered } from './feedback-delivery.js';
import { isReticleSourceCheckout } from './dev-repo.js';
import { saveFeedbackLocally } from './feedback-local.js';
import { SERVER_VERSION } from '@/command/version/identity/server-version.js';
import { feedbackContext, type SessionFacts } from './feedback-context.js';
import { markDelivered, outboxPath, queueFeedback, readOutbox } from './feedback-outbox.js';

/** Kills the feedback channel ONLY — adoption counters keep flowing. */
export const FEEDBACK_ENV = 'RETICLE_FEEDBACK';

/** What replaces a redacted match. Visible on purpose: a reader must see that something was removed. */
export const REDACTED = '[redacted]';

/** This machine, as a host: the app under test, never anybody's infrastructure. Port allowed. */
const LOCAL_HOST = /^(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|\[::1\])(?::\d+)?$/i;

/** A dotted name ending in one of these is a source file, not a host. */
const FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'md',
  'mdx',
  'css',
  'scss',
  'html',
  'vue',
  'svelte',
  'astro',
  'py',
  'rs',
  'go',
  'yml',
  'yaml',
  'toml',
  'lock',
  'log',
  'txt',
  'map',
  'sh',
  'env',
  'd',
]);

/** Top-level domains common enough that a one-dot name ending in one is a host. */
const COMMON_TLDS: ReadonlySet<string> = new Set([
  'com',
  'net',
  'org',
  'io',
  'dev',
  'app',
  'co',
  'ai',
  'cloud',
  'internal',
  'local',
  'corp',
  'lan',
  'site',
  'tech',
  'xyz',
  'us',
  'uk',
  'de',
  'in',
  'eu',
]);

/**
 * One path separator in every spelling that a report can carry: `/` and `\`, and the JSON-escaped
 * forms `\/`, `\\` and `\\/`. An agent that pastes a JSON string doubles each backslash.
 */
const PATH_SEP = String.raw`(?:\\{0,2}\/|\\{1,2})`;

/**
 * The shapes that leak. Ordered most-specific first — a URL carrying inline credentials must be
 * caught as a URL before the bare-token rule chews the middle out of it.
 *
 * This is a net, not a proof. It cannot catch a secret that looks like an ordinary word, which is
 * exactly why the tool description tells the agent not to paste app source or user data in the first
 * place. Defense in depth: instruct first, redact second, cap third.
 */
const REDACTIONS: readonly {
  readonly pattern: RegExp;
  readonly label: string;
  /** Builds the replacement; when absent, a leading capture is kept and the rest is redacted. */
  readonly replace?: (match: string, ...groups: string[]) => string;
}[] = [
  // scheme://user:pass@host — the credential is in the authority section.
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, label: 'url-credentials' },
  // A URL keeps its scheme, and its host and path ONLY when the host is this machine (the app under
  // test, which is what a report is about). Any other host is a staging site, a customer's domain
  // or an internal service, so it goes with its path. The query and fragment always go: that is
  // where ids, emails and tokens ride.
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#"'<>`]+)([^\s?#"'<>`]*)(?:[?#][^\s"'<>`]*)?/gi,
    label: 'url',
    replace: (_m, scheme = '', host = '', path = '') =>
      LOCAL_HOST.test(host) ? `${scheme}${host}${path}` : `${scheme}${REDACTED}`,
  },
  { pattern: /\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/gi, label: 'email' },
  // Credential assignments: the KEY stays (it is the useful part), the VALUE goes. The auth SCHEME
  // (`Bearer`, `Basic`, `Token`) is consumed as part of the value, not left as the value — matching
  // only `\S+` after the separator ate the word "Bearer" and published the secret right behind it.
  // A linking verb is skipped too: "my password is hunter2" lost the word "is" and kept hunter2.
  {
    pattern:
      /\b(authorization|api[-_]?key|secret|token|password|passwd|pwd)\b(?:\s*[:=]\s*|\s+(?:(?:is|was|=|:)\s+)?)(?:(?:bearer|basic|token|digest)\s+)?\S+/gi,
    label: 'credential-assignment',
  },
  // An environment-style assignment: `STRIPE_SECRET_KEY=…`, `AWS_SECRET_ACCESS_KEY=…`, `DB_PASS: …`.
  // `\b` does not end a word at `_`, so the rule above never saw these. The sensitive word must be
  // one whole `_` segment of the name, so `PASSPORT_ID` or `TOKENIZER_MODE` stay.
  {
    pattern:
      /\b((?:[A-Za-z0-9]+_)*(?:SECRET|TOKEN|PASS|PASSWORD|PASSWD|PWD|PASSPHRASE|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|AUTH|CREDENTIALS?)(?:_[A-Za-z0-9]+)*)\s*[:=]\s*\S+/gi,
    label: 'credential-assignment',
  },
  // Vendor key formats that are self-identifying (sk-…, sk_live_…, ghp_…, AKIA…, xoxb-…, eyJ… JWTs).
  { pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, label: 'vendor-key' },
  { pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, label: 'vendor-key' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, label: 'github-token' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: 'github-token' },
  { pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, label: 'gitlab-token' },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: 'google-key' },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, label: 'aws-key' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: 'slack-token' },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: 'jwt' },
  // A payment card: 13 to 19 digits, spaces or dashes allowed, that pass the Luhn check. An id or a
  // millisecond timestamp rarely starts with 2 to 6 AND passes Luhn, so those stay.
  {
    pattern: /\b[2-6](?:[ -]?\d){12,18}\b/g,
    label: 'card-number',
    replace: (digits) => (luhnValid(digits.replace(/\D/g, '')) ? REDACTED : digits),
  },
  // A phone number: an international `+` number, or a ten-digit (123) 456-7890 shape.
  {
    pattern: /(?<![\w+])\+\d[\d ().-]{6,18}\d(?!\w)/g,
    label: 'phone',
    replace: (number) => (8 <= number.replace(/\D/g, '').length ? REDACTED : number),
  },
  { pattern: /(?<![\w(])\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g, label: 'phone' },
  // Home directories carry the account name, and a trace is full of them. The name runs to the next
  // separator, quote or line end, NOT the next space: `C:\Users\Jane Doe\…` stopped at the space and
  // sent the surname. Then the rest of the path goes with it. Over-redacting a sentence that follows
  // a bare home directory is the price, and it is the right way round.
  {
    pattern: new RegExp(
      String.raw`(?:\\\\\?\\)?(?:${PATH_SEP}(?:Users|home)${PATH_SEP}|[A-Za-z]:${PATH_SEP}Users${PATH_SEP})[^\\/\r\n"'${'`'}]+(?:[\\/][^\s\\/"'${'`'}]*)*`,
      'gi',
    ),
    label: 'home-path',
  },
  // Any other absolute path: a Windows one (segments may hold spaces when a separator follows)...
  {
    pattern: /(?:\\\\\?\\)?\b[A-Za-z]:[\\/](?:[^\\/\r\n"'`<>|*?]+[\\/])*[^\s\\/"'`<>|*?]*/g,
    label: 'path',
  },
  // ...a home-relative one, and a POSIX one of two or more segments. A path is a directory layout,
  // and a directory layout names clients, projects and people.
  { pattern: /~[\\/][^\s"'`]*/g, label: 'path' },
  { pattern: /(?<![\w.~])\/[\w.@+-]+(?:\/[\w.@+-]+)+\/?/g, label: 'path' },
  {
    pattern: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
    label: 'ip',
    replace: (ip) => (LOCAL_HOST.test(ip) ? ip : REDACTED),
  },
  // Hostnames: a staging site, an internal service, a customer's domain. A dotted name is a host when
  // it has two or more dots or ends in a common top-level domain, and never when it ends in a source
  // file's extension — `vite.config.ts` is what a report is about, `db.internal.acme.com` is not.
  {
    pattern: /\b(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*\b/gi,
    label: 'hostname',
    replace: (name) => {
      const labels = name.toLowerCase().split('.');
      const last = labels[labels.length - 1] ?? '';
      if (FILE_EXTENSIONS.has(last)) return name;
      return labels.length > 2 || COMMON_TLDS.has(last) ? REDACTED : name;
    },
  },
];

/** The Luhn checksum every payment card number carries. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (1 === i % 2) {
      d *= 2;
      if (9 < d) d -= 9;
    }
    sum += d;
  }
  return 0 === sum % 10;
}

interface Redaction {
  text: string;
  /** Which rules fired, deduped. Surfaced back to the author so a redaction is never silent. */
  removed: string[];
}

/** Strip credential/PII shapes and cap the length. Pure — the tests read like a spec of what leaks. */
export function redactFeedbackText(input: string, max: number): Redaction {
  const removed = new Set<string>();
  let text = input;
  for (const { pattern, label, replace } of REDACTIONS) {
    text = text.replace(pattern, (match: string, ...groups: unknown[]) => {
      const captures = groups.map((g) => ('string' === typeof g ? g : ''));
      // A rule with a leading capture keeps it (the scheme, the `api_key=` key) so the reader still
      // sees WHAT was removed, not just that something was.
      const out =
        replace === undefined ? `${captures[0] ?? ''}${REDACTED}` : replace(match, ...captures);
      if (out !== match) removed.add(label);
      return out;
    });
  }
  return { text: text.slice(0, max), removed: [...removed] };
}

/** Our words in a trace: tool names and the verdict vocabulary. Nothing else is kept. */
const TRACE_WORDS =
  /\breticle_[a-z_]+\b|\b(?:verified|yes|no|unknown|no-fault|ok|passed|failed|refused|error|timeout)\b/gi;

/**
 * A trace reduced to Reticle's own words, in order: which tools were called and what verdict each
 * gave. The raw trace is the call/response trail, and the responses carry the page's text and what
 * was typed into it, which no redaction rule can tell from prose. So nothing else is kept.
 */
export function summarizeTrace(trace: string): string {
  return (trace.match(TRACE_WORDS) ?? []).join(' ').slice(0, FEEDBACK_TRACE_MAX);
}

/** The removal label when a trace lost anything to `summarizeTrace`. */
const TRACE_VALUES_LABEL = 'trace-values';

/** True when the feedback channel is switched off on its own (the emitter's switches apply as well). */
export function feedbackDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env[FEEDBACK_ENV] ?? '').toLowerCase();
  return '0' === value || 'false' === value || 'off' === value || 'no' === value;
}

/**
 * The fields an author writes, and therefore the fields that must be redacted. ONE list, used both to
 * redact and to assemble — so a new field cannot be added to one and missed by the other.
 *
 * `model` is deliberately included: it is agent-supplied text like the rest, and while a model name
 * is not sensitive, exempting it would re-introduce the "which fields are safe?" judgement call that
 * caused the original gap.
 */
const AUTHOR_WRITTEN_FIELDS: ReadonlySet<string> = new Set([
  'text',
  'trace',
  'need',
  'impact',
  'currentApproach',
  'model',
]);

const TRACE_FIELD = 'trace';

/** Per-field caps; anything unlisted uses the standard field cap. */
const FIELD_CAPS: Record<string, number> = {
  text: FEEDBACK_TEXT_MAX,
  trace: FEEDBACK_TRACE_MAX,
  model: 64,
};

/** What the author supplies; the environment context is detected, never asked for. */
type FeedbackInput = Pick<
  Feedback,
  | 'source'
  | 'kind'
  | 'text'
  | 'trace'
  | 'rating'
  | 'need'
  | 'impact'
  | 'currentApproach'
  | 'model'
  | 'contact'
>;

interface FeedbackReceipt {
  /**
   * DELIVERY confirmed. Only ever true when the send was awaited and the endpoint accepted it —
   * never as an optimistic stand-in for "we handed it to the emitter". That distinction is the whole
   * value of this field: it was once unconditional, so a DNS miss and a 4xx both reported "filed".
   *
   * A backgrounded send (the agent tool) therefore returns `sent: false` with `accepted: true` —
   * see below. It is not a failure, and the note says so.
   */
  sent: boolean;
  /**
   * Validated, redacted and handed to the emitter. TRUE says the report is well-formed and on its
   * way; it does NOT say it arrived. If a backgrounded send then fails, the reporter is told on its
   * next tool result — see feedback-delivery.ts.
   */
  accepted: boolean;
  reason?: string;
  /**
   * Where the report was written when it could not be SENT.
   *
   * A refusal used to be the end of the road: the report was already written by then, and throwing
   * it away punished exactly the behaviour this channel exists to encourage. Worse, the commonest
   * refusal is a Reticle SOURCE CHECKOUT — so the reporter best placed to name a file and a line was
   * the only one who could not file at all.
   */
  savedTo?: string;
  /** A ready-to-run command that turns the saved file into an issue. */
  fileWith?: string;
  /** Which redaction rules fired. Empty when nothing needed removing. */
  redacted: string[];
  /** The exact context that went with it, echoed back so the send is never a black box. */
  context: Partial<Feedback>;
}

/**
 * Redact, validate, and emit one feedback report. Returns a receipt rather than throwing: a feedback
 * send that fails must never take down the tool call that reported the failure — that would punish
 * the exact behaviour we are trying to encourage.
 */
export async function submitFeedback(
  input: FeedbackInput,
  opts: {
    cwd?: string;
    session?: SessionFacts;
    env?: NodeJS.ProcessEnv;
    /**
     * Return as soon as the report is validated and queued, instead of waiting out the POST.
     *
     * Used by the AGENT tool: ~340ms of network on a call made mid-task is the product blocking the
     * user's work to talk about itself. NOT used by `reticle feedback`, where a human typed the
     * command and is waiting for an answer — there, confirmed delivery is the answer.
     */
    background?: boolean;
  } = {},
): Promise<FeedbackReceipt> {
  const env = opts.env ?? process.env;
  const context = feedbackContext(opts.cwd ?? process.cwd(), opts.session);
  // Redact EVERY author-written field, derived from the input rather than listed.
  //
  // The first version named `text` and `trace` explicitly. When `need`, `impact` and
  // `currentApproach` were added later they silently bypassed redaction entirely — three new
  // free-text fields going to the wire raw, and a `currentApproach` reading "hardcoding the token
  // sk-…" would have shipped the token. Enumerating the fields to protect is the same class of
  // mistake as hand-copying an enum: correct on the day it is written, quietly wrong at the next
  // addition. Deriving the set means a sixth field is covered the moment it exists.
  const redactions = redactAuthorFields(input);
  const body = redactions.get('text') ?? { text: '', removed: [] };
  const redacted = [...new Set([...redactions.values()].flatMap((r) => r.removed))];

  if (feedbackDisabled(env)) {
    return {
      sent: false,
      accepted: false,
      reason: `feedback is disabled by ${FEEDBACK_ENV}`,
      redacted,
      context,
    };
  }
  const telemetry = getTelemetry();
  if (!telemetry.enabled) {
    /*
     * Cannot SEND is not the same as cannot FILE.
     *
     * The report is fully written and redacted by this point. Discarding it punishes the exact
     * behaviour this channel exists to encourage, and it hits hardest where the reports are best: a
     * Reticle source checkout disables telemetry by cwd, so a contributor who can name the file and
     * the line was the one person who could not file at all.
     *
     * So it goes to disk and the receipt says where, plus a command that turns it into an issue.
     * Nothing is lost, and the human is handed one thing to run rather than asked to retype it.
     */
    const cwd = opts.cwd ?? process.cwd();
    const saved = saveFeedbackLocally(cwd, input, body.text, context);
    return {
      sent: false,
      accepted: false,
      // Named precisely, because the commonest cause is not what the old wording suggested.
      reason: isReticleSourceCheckout(cwd)
        ? 'this is a Reticle source checkout, where telemetry is disabled by design, so this could not be sent — it has been written to disk instead, and nothing was lost.'
        : `telemetry is disabled on this machine, so this could not be sent — it has been written to disk instead. Re-enable with \`reticle telemetry enable\` to send directly.`,
      ...(saved === undefined ? {} : { savedTo: saved.path, fileWith: saved.command }),
      redacted,
      context,
    };
  }

  const parsed = FeedbackSchema.safeParse({
    source: input.source,
    kind: input.kind,
    // Every author-written field, redacted. Built from the map so nothing can be forgotten here
    // either — the field list exists in exactly one place.
    ...Object.fromEntries(
      [...redactions].filter(([, r]) => r.text !== '').map(([key, r]) => [key, r.text]),
    ),
    text: body.text,
    ...(input.rating !== undefined ? { rating: input.rating } : {}),
    // Not redacted: the person gave this address so the maintainers can answer. Sent only then.
    ...(input.contact !== undefined ? { contact: input.contact } : {}),
    ...context,
  });
  if (!parsed.success) {
    return {
      sent: false,
      accepted: false,
      reason: parsed.error.issues[0]?.message ?? 'invalid feedback',
      redacted,
      context,
    };
  }
  // BACKGROUND: return now, deliver after. The agent calls this mid-task and a ~340ms POST is the
  // product blocking the user's work to talk about itself. The honesty that the awaited version was
  // written for is kept elsewhere: `sent` stays false (nothing is confirmed yet), `accepted` says
  // the report is well-formed and queued, and a send that then fails reaches the reporter on its
  // next tool result instead of vanishing.
  // Written down BEFORE the network is touched, on both paths. A failed send is then a queued report
  // rather than a lost one — see feedback-outbox. Reported from the field: a 1.3s hiccup destroyed a
  // root-cause analysis that took an hour of driving to produce, and it survived only because the
  // reporter happened to have written the markdown by hand first.
  const queued = queueFeedback(parsed.data);

  if (true === opts.background) {
    void telemetry
      .emit(TelemetryEventKind.FEEDBACK_SUBMITTED, { feedback: parsed.data })
      .then((ok) => {
        if (ok) markDelivered(queued);
        else noteFeedbackUndelivered('the telemetry endpoint did not accept it');
      })
      .catch((error: unknown) => {
        noteFeedbackUndelivered(error instanceof Error ? error.message : String(error));
      });
    return { sent: false, accepted: true, redacted, context };
  }

  // `sent` reflects DELIVERY, not handing the payload to the emitter. It was unconditional, so a DNS
  // miss or a 4xx both reported "filed" — and this is the only qualitative channel the product has,
  // so a silent failure here loses the report AND tells the reporter it worked.
  const delivered = await telemetry.emit(TelemetryEventKind.FEEDBACK_SUBMITTED, {
    feedback: parsed.data,
  });
  if (delivered) {
    markDelivered(queued);
    return { sent: true, accepted: true, redacted, context };
  }
  // Undelivered, but no longer lost. `accepted` is true when it reached the outbox: the report is
  // well-formed and on disk, which is a materially different situation from "it is gone".
  return {
    sent: false,
    accepted: queued !== null,
    reason:
      queued !== null
        ? `the report could not be delivered (the network call failed or was rejected), but it is SAVED at ${outboxPath()} and nothing was lost. It will be retried; you can also open an issue at https://github.com/reticlehq/reticle/issues with the same detail.`
        : 'the report could not be delivered and could not be saved locally either — it was NOT filed. Retry, or open an issue at https://github.com/reticlehq/reticle/issues with the same detail.',
    redacted,
    context,
  };
}

/**
 * Every author-written field of a report, redacted under the CURRENT rules. One function for the
 * send and for the outbox drain, so a report queued under older, weaker rules is re-redacted before
 * it finally goes.
 */
function redactAuthorFields(input: Record<string, unknown>): Map<string, Redaction> {
  const redactions = new Map<string, Redaction>();
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string' || '' === value) continue;
    if (!AUTHOR_WRITTEN_FIELDS.has(key)) continue;
    if (TRACE_FIELD === key) {
      const summary = summarizeTrace(value);
      redactions.set(key, {
        text: summary,
        removed: summary === value ? [] : [TRACE_VALUES_LABEL],
      });
      continue;
    }
    redactions.set(key, redactFeedbackText(value, FIELD_CAPS[key] ?? FEEDBACK_FIELD_MAX));
  }
  return redactions;
}

/** Reports one daemon start retries. A backlog drains over several starts, never in one burst. */
const OUTBOX_DRAIN_MAX = 5;

/**
 * Retry what the outbox holds: the receipt for an undelivered report promises "It will be retried",
 * and until this ran on daemon start nothing ever read the outbox back. Bounded, sequential, and
 * best-effort; a report the endpoint does not accept stays queued. Returns how many were delivered.
 */
export async function drainFeedbackOutbox(
  telemetry: Telemetry = getTelemetry(),
  home: string = homedir(),
): Promise<number> {
  if (!telemetry.enabled || feedbackDisabled()) return 0;
  let delivered = 0;
  for (const entry of readOutbox(home).slice(0, OUTBOX_DRAIN_MAX)) {
    const queued = FeedbackSchema.safeParse(entry.payload);
    // A payload that cannot pass the schema can never be sent; it stays where a person can read it.
    if (!queued.success) continue;
    const fields = Object.fromEntries(
      [...redactAuthorFields(queued.data)].map(([key, r]) => [key, r.text]),
    );
    const parsed = FeedbackSchema.safeParse({ ...queued.data, ...fields });
    if (!parsed.success) continue;
    try {
      if (await telemetry.emit(TelemetryEventKind.FEEDBACK_SUBMITTED, { feedback: parsed.data })) {
        markDelivered(entry.id, home);
        delivered += 1;
      }
    } catch {
      /* stays queued for the next start */
    }
  }
  return delivered;
}

/**
 * The receipt's context PLUS the fields the emitter stamps on every event regardless of kind — the
 * reticle version, the OS, and whether this is CI. They are the single most-asked question of any bug
 * report ("what version?"), so they are echoed here rather than left as an invisible claim: what the
 * CLI prints is then genuinely everything that goes.
 */
export function describeFeedbackPayload(context: Partial<Feedback>): Record<string, unknown> {
  return {
    ...context,
    version: SERVER_VERSION,
    os: platform(),
    ci: process.env['CI'] !== undefined,
  };
}
