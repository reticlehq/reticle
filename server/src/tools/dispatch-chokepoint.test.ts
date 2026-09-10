import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every tool call must pass through `runTool`, or be declared here as a path that does not.
 *
 * `docs/telemetry-contract.md` rule 1: tool usage, timing, errors, verdicts and defects are recorded
 * in ONE place — `runTool` in `tools/invoke-tool.ts`. Adding a tool to `TOOLS` is all it takes to be
 * instrumented. The contract then says the thing this file exists to enforce:
 *
 *   "If you add a second dispatch path, it needs the same treatment, and until it has one it is
 *    invisible. That gap existed for real: CI-found bugs were uncounted."
 *
 * Invisible is the operative word. Telemetry fails SILENTLY — nothing throws, no test reddens, and
 * the data is permanently absent for a period nobody can re-collect. So the rule cannot live in
 * prose, for the same reason every other rule in this repo migrated out of prose: the ones a machine
 * enforces have held, and the ones left to discipline have not.
 *
 * The check is deliberately crude — a source scan for `.handler(` — because the failure it guards is
 * crude: somebody reaches past the chokepoint and nothing anywhere says so. A new bypass fails here,
 * in milliseconds, and its author has to write down why it is acceptable.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');

/** `.handler(` is how a tool is invoked directly, sidestepping runTool's recording. */
const DIRECT_INVOCATION = /\.handler\(/;

/**
 * The dispatch paths that legitimately bypass `runTool`, each with the reason it is tolerable.
 *
 * A path in this list is NOT necessarily fine — two of the three below are known observability gaps,
 * written down rather than fixed because fixing them means changing what a family tool reports, and
 * that is a telemetry decision with a published number attached. The value of the list is that they
 * are now *known*, and that the next one cannot arrive unnoticed.
 */
const DECLARED_BYPASSES: Readonly<Record<string, string>> = {
  'tools/merge-tools.ts':
    'A family tool (reticle_flow, reticle_session, …) dispatches to the member its `action` names. ' +
    'The OUTER call went through runTool, so nothing is uncounted — but it is counted as the FAMILY, ' +
    'so `toolCounts` cannot say which member ran. Known gap: the same family folding that means ' +
    '"every tool is callable" is asserted over 48 surfaces and not 68 behaviours (docs/system-map.md).',
  'flows/verify-change-tools.ts':
    'reticle_verify_change replays the affected flows by calling reticle_flow_verify directly. The ' +
    'outer call is recorded; the inner suite run is not counted as its own tool call. Deliberate — ' +
    'counting it would double-count one agent action — but it means flow_verify usage is ' +
    'understated by however often verify_change is the caller.',
  'bridge/bridge.test-harness.ts':
    'A test harness, not a product path. It exists precisely to call handlers without the daemon ' +
    'around them.',
};

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    // `.test.ts` files call handlers constantly and by design — that is what a unit test of a tool
    // IS. Excluding them is not a loophole: a test emits no telemetry anybody counts.
    if (entry.endsWith('.test.ts')) continue;
    found.push(full);
  }
  return found;
}

describe('every dispatch path is either the chokepoint or declared', () => {
  const bypasses = sourceFiles(SRC)
    .filter((file) => DIRECT_INVOCATION.test(readFileSync(file, 'utf8')))
    .map((file) => relative(SRC, file).split('\\').join('/'))
    // invoke-tool.ts IS the chokepoint. It is supposed to call the handler; that is its whole job.
    .filter((rel) => rel !== 'tools/invoke-tool.ts');

  it('no undeclared path reaches past runTool', () => {
    const undeclared = bypasses.filter((rel) => DECLARED_BYPASSES[rel] === undefined);
    expect(
      undeclared,
      0 === undeclared.length
        ? ''
        : `these call a tool handler directly, bypassing runTool's recording:\n` +
            undeclared.map((f) => `  ${f}`).join('\n') +
            `\n\nEither route the call through runTool, or add it to DECLARED_BYPASSES with the ` +
            `reason it is acceptable and what it costs. Telemetry fails silently — an undeclared ` +
            `path is invisible, and nothing else will ever tell you.`,
    ).toEqual([]);
  });

  it('every declaration still corresponds to a real path', () => {
    // The other direction, and the one that rots. A declaration left behind after its bypass was
    // removed makes the list read as bigger than the problem, and the next reader trusts it less.
    const stale = Object.keys(DECLARED_BYPASSES).filter((rel) => !bypasses.includes(rel));
    expect(
      stale,
      `declared as bypasses but no longer call a handler directly — delete these: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('every declaration says WHY, at length enough to be a reason', () => {
    // A one-word reason is a rubber stamp. The point of the list is that adding to it costs thought.
    for (const [path, reason] of Object.entries(DECLARED_BYPASSES)) {
      expect(reason.length, `${path} needs a real reason, not a label`).toBeGreaterThan(60);
    }
  });

  it('the chokepoint is where the contract says it is', () => {
    // If runTool moves or is renamed, the scan above starts passing for the wrong reason — it would
    // find no bypasses because it no longer knows what the chokepoint is.
    const chokepoint = readFileSync(join(SRC, 'tools', 'invoke-tool.ts'), 'utf8');
    expect(chokepoint).toContain('export async function runTool');
    expect(chokepoint).toMatch(DIRECT_INVOCATION);
  });
});
