/**
 * The end-of-run report: what an agent's run checked, what held, and what it left on disk.
 *
 * The server builds it from what it measured, and the agent shows it as the last part of its
 * answer. The agent does not write the verdicts: an agent asked to summarise an `unknown` tends to
 * summarise it into a pass. Every number here was counted during the run. A number that was not
 * measured is left out, never shown as a zero.
 */
import * as z from 'zod';
import { Verified } from './verified-constants.js';

/** The output field that carries the report. */
export const RUN_REPORT_FIELD = 'runReport';

/** What the agent does with the report. One sentence, said with the report every time. */
export const RUN_REPORT_INSTRUCTION =
  'End your answer to the user with `runReport.markdown`, unchanged. Do not reword its verdicts.';

/** Where the hosted dashboard is. */
export const CLOUD_DASHBOARD_URL = 'https://app.reticle.sh';

/**
 * The one line about Reticle Cloud. It is shown only when the project is not linked, it is
 * labelled, and `RETICLE_NO_UPSELL` turns it off. It names no price: the price lives in
 * reticle-cloud's billing, changes with the plan and the currency, and a number here would drift.
 */
export const CLOUD_VALUE_LINE =
  'Reticle Cloud (not linked): keeps this history across runs and agents, adds a team view and ' +
  `the hosted Harness. Plans and prices: ${CLOUD_DASHBOARD_URL}`;

export const RunReportClaimSchema = z.object({
  /** The claim, in the words the agent wrote. */
  claim: z.string(),
  verified: z.nativeEnum(Verified),
  /** One piece of evidence: what the check saw, or the source line it drove. */
  evidence: z.string().optional(),
});
export type RunReportClaim = z.infer<typeof RunReportClaimSchema>;

export const RunReportSchema = z.object({
  /** The run's verdict: `no` when any claim failed, `yes` only when every claim held. */
  verified: z.nativeEnum(Verified),
  claims: z.array(RunReportClaimSchema),
  /** Claims the agent expected to hold that Reticle found false. */
  caught: z.array(z.string()),
  flows: z.object({
    saved: z.array(z.string()),
    replayed: z.array(z.object({ name: z.string(), verified: z.nativeEnum(Verified) })),
  }),
  memory: z.object({
    /** Notes and statements written for the next run. */
    written: z.number().int().min(0),
    /** Notes and statements from earlier runs that this run was given. */
    read: z.number().int().min(0),
  }),
  /** From the run's first Reticle call to this report. */
  wallMs: z.number().int().min(0),
  /** From the run's first Reticle call to its first decided claim or replay. Absent when none. */
  firstVerdictMs: z.number().int().min(0).optional(),
  /** `CLOUD_VALUE_LINE`, only when the project is not linked. */
  cloud: z.string().optional(),
});
export type RunReport = z.infer<typeof RunReportSchema>;
