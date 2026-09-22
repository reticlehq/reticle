#!/usr/bin/env node
// Score the CLI realm against the specification's own scenarios.
//
//   node conformance/run-cli.mjs [--gate]
//
// A sibling of `run-self.mjs` and `run-desktop.mjs`, and the first one whose subject is not a
// page. No DOM, no request to intercept, no screen to photograph — which is what makes it worth
// running: the claim that the adjudicator is realm-blind has never been tested against a subject
// that has none of those.
//
// Every verdict here is decided by the specification's `adjudicate`, never by Reticle's own
// kernel. Scoring an implementation against its own rules makes every implementation conformant
// by construction.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { driveAll } from './drive.mjs';
import { CLI_SMOKE_SUBJECT } from './subjects/cli-smoke.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const { CliRealm, NodeSupervisor, nodeWorkspace } = await import(
  `file://${join(REPO, 'adapters/realm/cli/dist/index.js')}`
);
const { adjudicate, Declaration, assertionsHeldUnder } = await import(
  `file://${join(REPO, 'open-verification/dist/index.js')}`
);

const SMOKE = join(REPO, 'apps/cli-smoke/smoke.mjs');

/**
 * The binding: three methods over a realm, which is all `driveAll` asks for.
 *
 * `command` plants a scenario by RUNNING it, because on this surface planting and acting are the
 * same act: there is no page to put into a state and then drive. A scenario this subject cannot
 * produce is refused rather than approximated, and the driver scores a refusal as absent, never
 * as a pass.
 */
function client() {
  let open;
  let realm;
  let workspace;
  let entry;

  return {
    hello: () =>
      Promise.resolve({
        name: '@reticlehq/cli-realm',
        version: '3.1.0',
        platform: 'native',
        // Declared from the realm itself rather than written down here, so the handshake cannot
        // drift from what the implementation actually observes. Rule 3 of the suite: what you
        // registered must match what you declared on connect.
        channels: probeRealm()
          .channels()
          .map((c) => c.id),
        commands: ['plant'],
        profile: undefined,
      }),

    async command(_name, args = {}) {
      entry = Object.values(CLI_SMOKE_SUBJECT).find(
        (_, i) => Object.keys(CLI_SMOKE_SUBJECT)[i] === args.scenario,
      );
      if (entry === undefined) return { planted: false, reason: 'this subject cannot produce it' };

      workspace = mkdtempSync(join(tmpdir(), 'cli-conf-'));
      const out = join(workspace, 'work');
      realm = build(workspace, out, entry);

      // Run it once first when the scenario IS the second run. A build that is idempotent is a
      // build behaving correctly, and the second run of one is where the question lives.
      if (entry.runTwice === true) {
        const warm = realm.openWindow(30_000);
        await realm.perform({
          id: 'warm',
          actor: 'conformance',
          capability: 'run',
          at: Date.now(),
        });
        realm.closeWindow(warm);
      }

      open = realm.openWindow(entry.budgetMs ?? 30_000);
      await realm.perform({ id: 'act', actor: 'conformance', capability: 'run', at: Date.now() });
      return { planted: true, claim: entry.claim, out };
    },

    async verify(claim) {
      const window = realm.closeWindow(open);
      const observed = await realm.observe(window);
      const coverage = await realm.coverage(window);
      const declared = {
        id: 'c1',
        statement: typeof claim === 'string' ? claim : entry.claim,
        declaredAt:
          entry.declaredAfter === true ? Declaration.AFTER_ACTION : Declaration.BEFORE_ACTION,
        assertions:
          entry.declareNothing === true
            ? []
            : [
                {
                  id: 'a1',
                  predicate: {
                    kind: 'present',
                    match: { channel: 'x-artifact', summary: 'cli.fs.written' },
                  },
                  reads: 'something was written under the declared roots',
                  channels: ['x-artifact'],
                },
              ],
      };
      const decided = adjudicate({
        claim: declared,
        window,
        channels: realm.channels(),
        evidence: observed
          .filter((o) => o.channel === 'x-artifact')
          .map((o) => ({
            observation: o,
            provenance: {
              class: 'observed',
              source: '@reticlehq/cli-realm',
              method: 'filesystem snapshot, before and after',
              subject: realm.identity(),
              at: Date.now(),
            },
            independence: 'independent',
            grade: 'consequence',
          })),
        coverage,
        anomalies: await realm.detect(window, observed),
        // Coverage-aware, and that is not a detail. `assertionsHeld` answers about the
        // OBSERVATIONS; an empty window means "nothing happened" OR "nobody was looking", and
        // clause 4 runs before the coverage check, so a confident `false` here reports a lost
        // vantage point as a broken application.
        assertionsHeld: assertionsHeldUnder(declared.assertions, observed, coverage),
        // Supplied only for a STATE claim. A write is an event inside the window and cannot have
        // been true beforehand; feeding a before-state to one sends a working tool to clause 10.
        consequenceHeldBefore:
          entry.about === 'state'
            ? realm.existedBefore(window, join(workspace, 'work', 'built.txt'))
            : undefined,
      });
      rmSync(workspace, { recursive: true, force: true });
      return {
        verdict: decided.verdict,
        ground: decided.ground,
        ...(decided.reasons[0] === undefined ? {} : { reason: decided.reasons[0] }),
      };
    },
  };
}

function build(workspace, out, entry) {
  const supervisor = new NodeSupervisor({
    executable: process.execPath,
    workspaceRoot: workspace,
    tool: { id: 'cli-smoke', version: '1', workspace },
    now: () => Date.now(),
  });
  return new CliRealm({
    supervisor,
    manifest: {
      workspaceRoot: workspace,
      commands: [
        {
          name: 'run',
          meaning: 'run the smoke tool in one of its scenarios',
          mutating: true,
          argv: [SMOKE, '--scenario', entry.scenario, '--out', out],
        },
      ],
    },
    workspace: nodeWorkspace([workspace]),
    now: () => Date.now(),
  });
}

/** A throwaway realm, only so the handshake reports what the implementation really declares. */
function probeRealm() {
  const root = mkdtempSync(join(tmpdir(), 'cli-probe-'));
  const realm = build(root, join(root, 'work'), { scenario: 'healthy' });
  rmSync(root, { recursive: true, force: true });
  return realm;
}

const report = await driveAll(client(), {
  name: '@reticlehq/cli-realm',
  version: '3.1.0',
  platform: 'native',
  channels: probeRealm()
    .channels()
    .map((c) => c.id),
  profile: undefined,
});

for (const [id, outcome] of Object.entries(report.outcomes ?? {})) {
  console.error(`${String(outcome).padEnd(11)} ${id}`);
}

/**
 * Gates REGRESSION, never the score.
 *
 * A scenario this subject cannot plant is `absent` and must never fail the build: that is the
 * fixture's limit rather than the implementation's, and failing on it would push somebody to
 * invent a defect to raise a number. Only a scenario that WAS driven and answered wrongly is a
 * regression, which is the same rule the other two runners apply.
 */
const failed = report.failed ?? [];
console.error(
  `\n${Object.values(report.outcomes ?? {}).filter((o) => o === 'passed').length} passed, ` +
    `${failed.length} failed, ` +
    `${Object.values(report.outcomes ?? {}).filter((o) => o === 'absent').length} absent`,
);
if (args.includes('--gate') && failed.length > 0) {
  console.error(`\nFAILED: ${failed.join(', ')}`);
  process.exit(1);
}
