#!/usr/bin/env node
// Drive one command and WATCH it prove itself.
//
//   reticle-cli-drive --expect "<what should become true>" --path <file> -- <command> [args...]
//
// The point of this binary is that verification is something you can SEE happening rather than a
// paragraph you read afterwards. It paints a live pane: the claim first, the channels being
// watched, output and filesystem changes as they land, and a verdict that is honestly absent
// until the window closes.
//
// Everything it prints is the same record the adjudicator reasons over. A human and an agent
// looking at different evidence and disagreeing about what happened is the failure this is shaped
// to prevent.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const {
  CliRealm,
  NodeSupervisor,
  nodeWorkspace,
  createLiveHud,
  renderReport,
  EXCLUDED_BY_DEFAULT,
} = await import(join(HERE, '..', 'dist', 'index.js'));
const { adjudicate, Declaration, assertionsHeldUnder } = await import('open-verification');

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 || i > (sep === -1 ? argv.length : sep) ? undefined : argv[i + 1];
};
const expectation = flag('--expect');
const expectPath = flag('--path');
const root = resolve(flag('--cwd') ?? process.cwd());
const command = sep === -1 ? [] : argv.slice(sep + 1);

if (expectation === undefined || expectPath === undefined || command.length === 0) {
  process.stderr.write(
    'usage: reticle-cli-drive --expect "<claim>" --path <file> [--cwd <dir>] [--json] -- <command> [args...]\n\n' +
      'The claim and the path are required and are declared BEFORE the command runs. That ordering\n' +
      'is the method: an expectation written after the result can be talked into agreeing with it.\n',
  );
  process.exit(2);
}

const supervisor = new NodeSupervisor({
  executable: command[0],
  workspaceRoot: root,
  tool: { id: command[0], version: 'unknown', workspace: root },
  now: () => Date.now(),
});
/*
 * Never exclude the thing you were asked to watch.
 *
 * `dist` is in the default exclusion list -- it is somebody else's build output and hashing it
 * twice a window is expensive -- and `dist/` is also the single commonest place a CLI writes. So a
 * caller naming `--path dist/index.js` got a snapshot that structurally could not see it, an empty
 * diff, and a confident `no` about a build that had worked. A FALSE POSITIVE, which costs more
 * than a miss, because a check that cries wolf stops being read.
 *
 * Found by an agent driving this against a healthy build and refusing to believe the verdict. It
 * had to read this package's source to work out why, which is the part that makes it serious: the
 * JSON handed it a contradicted verdict and no hint that the target was invisible.
 *
 * A default exclusion is a cost-saving guess. A path the caller named is not a guess, so it wins.
 */
const declaredRoot = expectPath.split('/')[0];
const exclude = EXCLUDED_BY_DEFAULT.filter((dir) => dir !== declaredRoot);

const realm = new CliRealm({
  supervisor,
  manifest: {
    workspaceRoot: root,
    commands: [{ name: command[0], meaning: expectation, mutating: true, argv: command.slice(1) }],
  },
  workspace: nodeWorkspace([root], { exclude }),
  now: () => Date.now(),
});

const hud = createLiveHud({
  expectation,
  workspaceRoot: root,
  now: () => Date.now(),
  // Only paint when somebody is watching. Piped into a file or a CI log, the pane would be
  // thousands of repaint frames, so a non-interactive run stays silent and prints the report.
  ...(process.stderr.isTTY === true ? { write: (f) => process.stderr.write(f) } : {}),
});

const claim = {
  id: 'c1',
  statement: expectation,
  declaredAt: Declaration.BEFORE_ACTION,
  assertions: [
    {
      id: 'a1',
      predicate: {
        kind: 'present',
        match: { channel: 'x-artifact', summary: 'cli.fs.written', valueContains: expectPath },
      },
      reads: `${expectPath} was written`,
      channels: ['x-artifact'],
    },
  ],
};

hud.send({
  kind: 'started',
  command: command[0],
  argv: command.slice(1),
  watching: realm.channels().map((c) => c.id),
});

const window = realm.openWindow(600_000);
await supervisor.run(command[0], command.slice(1), 600_000, {
  onStdout: (text) => hud.send({ kind: 'stdout', text }),
  onStderr: (text) => hud.send({ kind: 'stderr', text }),
});
const closed = realm.closeWindow(window);
const observed = await realm.observe(closed);
const coverage = await realm.coverage(closed);
const changes = realm.changesIn(closed);
hud.send({ kind: 'changed', changes });
hud.send({ kind: 'ended', exit: undefined });

const decided = adjudicate({
  claim,
  window: closed,
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
  anomalies: await realm.detect(closed, observed),
  assertionsHeld: assertionsHeldUnder(claim.assertions, observed, coverage),
  consequenceHeldBefore: undefined,
});

hud.send({
  kind: 'verdict',
  verdict: {
    verdict: decided.verdict,
    ground: decided.ground,
    boughtBy: decided.verdict === 'yes' ? 'x-artifact' : undefined,
  },
});
hud.stop();

/*
 * Machine-readable, because the whole argument for a binary over an MCP tool is that an agent can
 * run it -- and an agent parsing a rendered report to decide what to do next is absurd. This is
 * the shape a caller branches on: the verdict, WHAT BOUGHT IT, what changed, and what was not
 * seen. The blind spots travel with it deliberately: a caller deciding from a verdict without
 * knowing what the verifier could not see is making the decision this project exists to improve,
 * with better manners.
 */
if (argv.includes('--json')) {
  const exit = observed.find((o) => o.summary === 'cli.exit.code');
  process.stdout.write(
    JSON.stringify(
      {
        verdict: decided.verdict,
        ground: decided.ground,
        grade: decided.grade ?? null,
        boughtBy: decided.verdict === 'yes' ? 'x-artifact' : null,
        proved: decided.verdict === 'yes',
        expectation,
        command: { name: command[0], argv: command.slice(1) },
        // Present and visibly NOT what decided, for the same reason the rendered pane shows it.
        exit: exit?.value ?? null,
        durationMs: Number(observed.find((o) => o.summary === 'cli.duration.ms')?.value ?? 0),
        changes: changes.map((c) => ({
          path: c.path.startsWith(root) ? `.${c.path.slice(root.length)}` : c.path,
          kind: c.kind,
        })),
        blindSpots: coverage.blindSpots.map((s) => ({
          kind: s.kind,
          detail: s.detail,
          impeaching: s.impeaching,
        })),
        reasons: decided.reasons,
      },
      null,
      2,
    ) + '\n',
  );
} else if (process.stderr.isTTY !== true) {
  const exit = observed.find((o) => o.summary === 'cli.exit.code');
  process.stderr.write(
    renderReport({
      expectation,
      command: command[0],
      argv: command.slice(1),
      durationMs: Number(observed.find((o) => o.summary === 'cli.duration.ms')?.value ?? 0),
      exit: { code: exit?.value, signal: undefined, wasSignalled: false },
      changes,
      blindSpots: coverage.blindSpots,
      adjudication: decided,
      declaredAt: claim.declaredAt,
      boughtBy: decided.verdict === 'yes' ? 'x-artifact' : undefined,
      workspaceRoot: root,
    }) + '\n',
  );
}

// A drive that did not PROVE its claim exits non-zero, so this composes into a script. `unknown`
// is not success: it is the verifier saying it could not tell, and a pipeline that treats that as
// a pass has reinvented the exit code this whole thing exists to distrust.
process.exit(decided.verdict === 'yes' ? 0 : 1);
