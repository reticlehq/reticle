/**
 * Run a CI command, and tell the difference between "this failed" and "the runner could not start
 * it".
 *
 * Windows runners intermittently refuse to start a process at all: the step exits
 * `-1073741502` (`0xC0000142`, STATUS_DLL_INIT_FAILED) with no output, sometimes 0.02s in, before a
 * single test has run. Observed twice in one day on two different steps, both re-running clean.
 *
 * The product is fine, and that is exactly the problem. The red is indistinguishable from a real
 * failure until somebody opens the log and recognises an obscure NT status code, and a `gate`
 * aggregator goes red behind it, so one infrastructure hiccup presents as two failing checks. This
 * repo already treats "reports the machine as a defect" as a bug class of its own.
 *
 * Two things, and the order matters:
 *
 *   1. NAME it. The log says in words that the runner failed to start the process and that this is
 *      an environment failure, not a test failure.
 *   2. Retry ONLY that. Safe here in a way a general retry is not: the process never started, so no
 *      user code ran and there is no partial state for a second attempt to be confused by.
 *
 * A retry without the naming would be worse than neither. Silently re-running a genuinely broken
 * build is how a flaky suite becomes a trusted-but-wrong one, so every retry is announced, and every
 * other exit code fails immediately with no second attempt.
 *
 * Usage: node scripts/ci-run.mjs <command> [args...]
 */

import { spawn } from 'node:child_process';

/**
 * Exit codes that mean the OS refused to start the process, never that the process failed.
 *
 * Node reports these as the signed 32-bit reading of the NT status, which is why they are negative.
 * Kept as a closed list rather than "any large negative number": a crash inside a real test can also
 * produce an unusual code, and retrying that would hide a genuine defect.
 */
export const RUNNER_LEVEL_EXIT_CODES = new Map([
  [-1073741502, '0xC0000142 STATUS_DLL_INIT_FAILED — a DLL failed to initialise at process start'],
  [-1073741819, '0xC0000005 STATUS_ACCESS_VIOLATION — the process died before running'],
]);

/**
 * Should this exit code be retried once, and what do we say about it?
 *
 * Pure, and exported so the decision is testable without spawning anything. `null` means "not a
 * runner-level failure": fail immediately, whatever the code.
 */
export function runnerLevelFailure(code) {
  if (code === null || code === undefined) return null;
  return RUNNER_LEVEL_EXIT_CODES.get(code) ?? null;
}

/** The sentence printed when one of these is seen. Named so the test asserts the claim, not prose. */
export function explain(code, detail, willRetry) {
  return (
    `[ci-run] the runner failed to START this process (exit ${String(code)}: ${detail}). ` +
    `This is an environment failure, not a test failure: no user code ran. ` +
    (willRetry ? 'Retrying once.' : 'The retry hit it as well, so this run is being failed.')
  );
}

/**
 * Did a runner-level code appear in the OUTPUT, even though the process exited with something else?
 *
 * This is not belt-and-braces, it is the main path on Windows. Every step this wraps runs through
 * turbo, and turbo CATCHES a child's exit code and exits 1 itself, printing the real one:
 *
 *   ERROR  @reticlehq/vite-plugin#build: command (...) pnpm.CMD run build exited (-1073741502)
 *   ERROR  run failed: command  exited (-1073741502)
 *   Process completed with exit code 1
 *
 * So the wrapper's own child exits 1, which is correctly NOT retryable, and the STATUS_DLL_INIT_FAILED
 * underneath it was invisible. Watching only the exit code made this wrapper useless for exactly the
 * commands it wraps — observed on main, turning it red on a changelog-only commit.
 *
 * Scoped to the same closed list, and it still requires a FAILING run: a build that passes while the
 * string happens to appear in a log line is not a runner failure.
 */
export function runnerLevelInOutput(output) {
  for (const [code, detail] of RUNNER_LEVEL_EXIT_CODES) {
    if (output.includes(String(code))) return detail;
  }
  return null;
}

function runOnce(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      // Piped rather than inherited, so the output can be SCANNED as well as shown. Both streams are
      // forwarded unchanged as they arrive, so the log a human reads is identical to before.
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let seen = '';
    const tee = (stream, sink) => {
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk) => {
        seen += chunk;
        sink.write(chunk);
      });
    };
    tee(child.stdout, process.stdout);
    tee(child.stderr, process.stderr);
    child.on('error', (error) => {
      process.stderr.write(`[ci-run] could not spawn ${command}: ${error.message}\n`);
      resolve({ code: 1, output: seen });
    });
    child.on('close', (code) => resolve({ code, output: seen }));
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined) {
    process.stderr.write('usage: node scripts/ci-run.mjs <command> [args...]\n');
    process.exit(2);
  }

  const first = await runOnce(command, args);
  // Either signal counts: the code we were handed, or the code a wrapper underneath us swallowed.
  const detail =
    runnerLevelFailure(first.code) ?? (0 !== first.code ? runnerLevelInOutput(first.output) : null);
  if (detail === null) process.exit(first.code ?? 1);

  process.stderr.write(`${explain(first.code, detail, true)}\n`);
  const second = await runOnce(command, args);
  const again =
    runnerLevelFailure(second.code) ??
    (0 !== second.code ? runnerLevelInOutput(second.output) : null);
  if (again !== null) process.stderr.write(`${explain(second.code, again, false)}\n`);
  process.exit(second.code ?? 1);
}

// Only when run as a script; importing this for its pure helpers must not execute anything.
if (
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
) {
  await main();
}
