/**
 * `reticle doctor --fix`: repair a half-done install, then say what still needs a person.
 *
 * A repair changes only Reticle's own state: its pid file, its own stuck daemon, its own Chromium,
 * and its entry in an agent's MCP config. A row that needs a change to the user's app, a process
 * that Reticle cannot prove is its daemon, or an action only the user can do, is never changed
 * here. Its row already names the step, and this prints that step.
 *
 * Each repair checks again before it acts, so a second run finds nothing to do and changes nothing.
 */
import { DoctorRow, doctorRow, LABEL_COLUMN } from './doctor-rows.js';

type DoctorRowLabel = (typeof DoctorRow)[keyof typeof DoctorRow];

/** One safe repair. `needed` reads the machine; `apply` changes only Reticle's own state. */
export interface DoctorRepair {
  /** The doctor row this repair makes green. */
  readonly row: DoctorRowLabel;
  /** What the repair is about, in a few words, so two repairs on one row read apart. */
  readonly what: string;
  /** The manual step, printed when the repair is not possible or does not take. */
  readonly step: string;
  needed(): Promise<boolean>;
  apply(): Promise<void>;
}

/** What `--fix` says about each repair. */
export const FixOutcome = {
  FIXED: 'fixed',
  NOTHING: 'nothing to do',
  STILL_NEEDS: 'still needs',
} as const;

/** The mark doctor puts on a row that fails. */
const FAIL_MARK = '✗';

const FIX_HEADING = 'reticle doctor --fix';

/** The last line of a plain `doctor` run, when `--fix` can repair `count` rows. */
export function fixFooter(count: number): string | undefined {
  if (0 === count) {
    return undefined;
  }
  return `Run \`reticle doctor --fix\` to repair ${String(count)} of these.`;
}

/** How many repairs have work to do now. */
export async function countNeeded(repairs: readonly DoctorRepair[]): Promise<number> {
  let count = 0;
  for (const repair of repairs) {
    if (await repair.needed()) {
      count++;
    }
  }
  return count;
}

/** The row label at the head of a doctor line, or undefined for a line that is not a row. */
function rowLabelOf(line: string): string | undefined {
  const label = line.slice(0, LABEL_COLUMN + 2).trim();
  return 0 === label.length ? undefined : label;
}

async function applyOne(repair: DoctorRepair): Promise<string> {
  if (!(await repair.needed())) {
    return FixOutcome.NOTHING;
  }
  try {
    await repair.apply();
  } catch {
    // The check below decides. A repair that threw and a repair that did nothing say the same thing.
  }
  if (await repair.needed()) {
    return `${FixOutcome.STILL_NEEDS}: ${repair.step}`;
  }
  return FixOutcome.FIXED;
}

/**
 * Run doctor, apply the needed repairs in the given order, run doctor again, and print one line for
 * each repair and one for each row that still fails. True when no row fails after the repairs.
 */
export async function runDoctorFix(deps: {
  /** Runs doctor and returns its rows. Prints them only when `show` is true. */
  doctor: (show: boolean) => Promise<string[]>;
  repairs: readonly DoctorRepair[];
  print: (line: string) => void;
}): Promise<boolean> {
  await deps.doctor(true);
  const results: string[] = [];
  const stillFailing = new Set<string>();
  for (const repair of deps.repairs) {
    const outcome = await applyOne(repair);
    if (outcome.startsWith(FixOutcome.STILL_NEEDS)) {
      stillFailing.add(repair.row);
    }
    results.push(doctorRow(repair.row, `${repair.what}: ${outcome}`));
  }
  const after = await deps.doctor(false);
  const failures = after.filter((line) => line.includes(FAIL_MARK));
  deps.print('');
  deps.print(FIX_HEADING);
  for (const line of results) {
    deps.print(line);
  }
  for (const line of failures) {
    // A repair that did not take already printed its step for this row.
    const label = rowLabelOf(line);
    if (label !== undefined && stillFailing.has(label)) {
      continue;
    }
    deps.print(`  ${FixOutcome.STILL_NEEDS}: ${line.trim()}`);
  }
  return 0 === failures.length;
}
