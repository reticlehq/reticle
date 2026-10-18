/**
 * The end-of-run report: the run ledger as the agent shows it to the user.
 *
 * Added to the answer of the call that ends an agent's run: a session end, a yield, or a released
 * tab. A run that ended by releasing its tab got no word about the run before this, and its agent
 * wrote its own summary. The report is a schema'd object, the markdown built from it, and one
 * instruction. The cloud line is said only when the project is not linked, and it says what it is.
 */
import {
  CLOUD_VALUE_LINE,
  ReticleTool,
  RUN_REPORT_FIELD,
  RUN_REPORT_INSTRUCTION,
  UPGRADE_HINT_SILENCE_ENV,
  Verified,
  asString,
  type RunReport,
} from '@reticlehq/core';
import type { RunLedger } from '@/judgement/runs/run-ledger.js';
import { ResultWord, linkedToPlatform, seconds } from './reticle-result.js';

const HEAD = '**Reticle run report: ';
const SEP = ' · ';
/** Claims listed before the rest are counted: enough to read, not enough to flood a reply. */
const CLAIMS_SHOWN = 20;

const Said = {
  NOTHING_CHECKED: 'nothing was checked',
  CAUGHT: 'Caught, expected to hold and did not',
  FLOWS_SAVED: 'Flows saved',
  FLOWS_REPLAYED: 'Flows replayed',
  NO_FLOWS: 'Flows: none saved, none replayed',
  MEMORY: 'Memory',
  TIME: 'Time',
  FIRST_VERDICT: 'first verdict after',
} as const;

const WORD: Record<Verified, ResultWord> = {
  [Verified.YES]: ResultWord.PROVED,
  [Verified.NO]: ResultWord.FAILED,
  [Verified.UNKNOWN]: ResultWord.NOT_PROVED,
  [Verified.NO_FAULT]: ResultWord.NOT_PROVED,
};

const plural = (n: number, word: string): string => `${String(n)} ${word}${1 === n ? '' : 's'}`;

function headline(report: RunReport): string {
  const all = [...report.claims, ...report.flows.replayed].map((c) => c.verified);
  const count = (v: Verified): number => all.filter((each) => v === each).length;
  const total = all.length;
  const word = `${HEAD}${WORD[report.verified]}**${SEP}`;
  if (0 === total) return `${word}${Said.NOTHING_CHECKED}`;
  if (Verified.NO === report.verified)
    return `${word}${String(count(Verified.NO))} of ${plural(total, 'check')} did not hold`;
  if (Verified.YES === report.verified)
    return `${word}${String(total)} of ${plural(total, 'check')} held`;
  return `${word}${String(total - count(Verified.YES) - count(Verified.NO))} of ${plural(total, 'check')} undecided`;
}

/** The report as markdown: the verdict, each claim with its evidence, then what the run left. */
export function renderRunReport(report: RunReport): string {
  const claims = report.claims
    .slice(0, CLAIMS_SHOWN)
    .map((c) => `- ${c.verified}: ${c.claim}${c.evidence === undefined ? '' : ` (${c.evidence})`}`);
  const more = report.claims.length - CLAIMS_SHOWN;
  const { saved, replayed } = report.flows;
  const flows =
    0 === saved.length && 0 === replayed.length
      ? [`- ${Said.NO_FLOWS}`]
      : [
          ...(0 === saved.length ? [] : [`- ${Said.FLOWS_SAVED}: ${saved.join(', ')}`]),
          ...(0 === replayed.length
            ? []
            : [
                `- ${Said.FLOWS_REPLAYED}: ${replayed.map((r) => `${r.name} (${r.verified})`).join(', ')}`,
              ]),
        ];
  const time =
    report.firstVerdictMs === undefined
      ? seconds(report.wallMs)
      : `${seconds(report.wallMs)}, ${Said.FIRST_VERDICT} ${seconds(report.firstVerdictMs)}`;
  return [
    headline(report),
    ...claims,
    ...(0 < more ? [`- (+${String(more)} more claims)`] : []),
    ...(0 === report.caught.length ? [] : [`- ${Said.CAUGHT}: ${report.caught.join('; ')}`]),
    ...flows,
    `- ${Said.MEMORY}: ${plural(report.memory.written, 'note')} written, ${String(report.memory.read)} read`,
    `- ${Said.TIME}: ${time}`,
    ...(report.cloud === undefined ? [] : [`- ${report.cloud}`]),
  ].join('\n');
}

/** The calls that end an agent's run, by their own name or as an action of a merged tool. */
export function endsRun(tool: string, args: Record<string, unknown>): boolean {
  const action = asString(args['action']);
  switch (tool) {
    case ReticleTool.END_SESSION:
    case ReticleTool.YIELD:
    case ReticleTool.LEASE_RELEASE:
      return true;
    case ReticleTool.SESSION:
      return 'end' === action || 'yield' === action;
    case ReticleTool.LEASE:
      return 'release' === action;
    default:
      return false;
  }
}

/** `reticle_intent` actions that write a statement, and the ones that read them back. */
const IntentWrite = { RECORD: 'record', DECLARE: 'declare' } as const;
const INTENT_READS: ReadonlySet<string> = new Set(['list', 'index', 'subject', 'get']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  null !== value && 'object' === typeof value && !Array.isArray(value);

/** What an answer says the run saved or read. An answer that refused counts for nothing. */
export function noteToolResult(
  ledger: RunLedger,
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
): void {
  if (!isRecord(result) || result['error'] !== undefined) return;
  if (ReticleTool.FLOW_SAVE === tool || ReticleTool.FLOW_SAVE_RECORDED === tool) {
    const name = result['name'];
    if ('string' === typeof name) ledger.flowSaved(name);
    return;
  }
  const action = asString(args['action']);
  if (ReticleTool.INTENT === tool) {
    // The intent ledger in `.reticle/intent/` is the memory an unlinked project has.
    if (IntentWrite.RECORD === action) ledger.memoryWritten();
    const declared = args['intents'];
    if (IntentWrite.DECLARE === action && Array.isArray(declared))
      ledger.memoryWritten(declared.length);
    if (action !== undefined && INTENT_READS.has(action))
      ledger.memoryRead([JSON.stringify(result)]);
    return;
  }
  if (ReticleTool.MEMORY !== tool) return;
  if ('add' === action && result['added'] !== undefined) ledger.memoryWritten();
  const known = result['known'];
  if (Array.isArray(known)) ledger.memoryRead(known.map((entry) => JSON.stringify(entry)));
}

/** The report as an answer field, or no field when the ledger holds no run. Empties the ledger. */
export function runReportField(
  ledger: RunLedger,
  root: string | undefined,
  env: Record<string, string | undefined>,
  now: number,
): Partial<
  Record<typeof RUN_REPORT_FIELD, { report: RunReport; markdown: string; instruction: string }>
> {
  if (ledger.isEmpty()) return {};
  const taken = ledger.take(now);
  const silenced = env[UPGRADE_HINT_SILENCE_ENV] !== undefined;
  const linked = root === undefined || linkedToPlatform(root, env);
  const report: RunReport = silenced || linked ? taken : { ...taken, cloud: CLOUD_VALUE_LINE };
  return {
    [RUN_REPORT_FIELD]: {
      report,
      markdown: renderRunReport(report),
      instruction: RUN_REPORT_INSTRUCTION,
    },
  };
}
