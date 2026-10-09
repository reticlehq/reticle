import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RunAgentKind,
  RunFlowStatus,
  RunFramework,
  RunProfile,
  RunTrigger,
  type ReticleVerificationRun,
} from '@reticlehq/core';
import {
  buildVerificationRun,
  type VerificationRunInput,
} from '@/judgement/runs/artifact/build-verification-run.js';
import {
  expectNeedsDaemonMessage,
  portBusyMessage,
  runVerify,
  urlParts,
  type VerifyConnection,
  type VerifyPorts,
} from './cli-verify.js';
import { PortPresence } from '../daemon/binding/port-presence.js';
import { CLI_USAGE } from './cli-parse.js';
import { verifyResults } from './verify-results.js';

const NOW = 1_700_000_000_000;

function makeRun(flowStatus: RunFlowStatus | undefined): ReticleVerificationRun {
  const flows =
    flowStatus === undefined
      ? []
      : [
          {
            name: 'checkout',
            status: flowStatus,
            steps: 3,
            durationMs: 5,
            ...(flowStatus === RunFlowStatus.FAIL ? { failureReason: 'order never saved' } : {}),
          },
        ];
  const input: VerificationRunInput = {
    runId: 'run-test',
    durationMs: 5,
    profile: RunProfile.PROD_PREVIEW,
    project: { name: 'demo', framework: RunFramework.OTHER, previewUrl: 'http://x' },
    agent: { id: 'reticle-cli', kind: RunAgentKind.OEM_PIPELINE },
    trigger: { kind: RunTrigger.OEM },
    changedFiles: [],
    flows,
    checks: [],
    risks: [],
    evidence: { consoleErrors: [], networkAnomalies: [], stateAssertions: [], timeline: [] },
  };
  return buildVerificationRun(input, () => NOW);
}

interface Recorder {
  out: string[];
  fail: string[];
  exit: number[];
  closed: number;
  verifyCalls: number;
}

function harness(conn: Partial<VerifyConnection>): { ports: VerifyPorts; rec: Recorder } {
  const rec: Recorder = { out: [], fail: [], exit: [], closed: 0, verifyCalls: 0 };
  const connection: VerifyConnection = {
    sessionReady: conn.sessionReady ?? (() => Promise.resolve(true)),
    listFlows: conn.listFlows ?? (() => Promise.resolve(['checkout'])),
    verify:
      conn.verify ??
      (() => {
        rec.verifyCalls += 1;
        return Promise.resolve(makeRun(RunFlowStatus.PASS));
      }),
    close: () => {
      rec.closed += 1;
      return Promise.resolve();
    },
    // Absent unless the case under test supplies one — which is exactly how the live connection
    // behaves on a machine with no model configured.
    ...(conn.explore === undefined ? {} : { explore: conn.explore }),
  };
  const ports: VerifyPorts = {
    connect: () => Promise.resolve(connection),
    out: (line) => rec.out.push(line),
    fail: (line) => rec.fail.push(line),
    exit: (code) => rec.exit.push(code),
    cloud: () => Promise.resolve(null),
  };
  return { ports, rec };
}

const ARGS = { url: 'http://localhost:3000', timeoutMs: 1000 };
const EXPLORING = { ...ARGS, explore: true };

describe('urlParts', () => {
  it('flags localhost / 127.0.0.1 / ::1 as loopback', () => {
    expect(urlParts('http://localhost:4320').loopback).toBe(true);
    expect(urlParts('http://127.0.0.1:4320').loopback).toBe(true);
    expect(urlParts('http://[::1]:4320').loopback).toBe(true);
  });

  it('flags a hosted preview as non-loopback and returns its origin', () => {
    const r = urlParts('https://app.lovable.app/x');
    expect(r.loopback).toBe(false);
    expect(r.origin).toBe('https://app.lovable.app');
  });

  it('returns loopback:false for an unparseable url', () => {
    expect(urlParts('not a url').loopback).toBe(false);
  });
});

describe('runVerify', () => {
  it('exits 0 and prints the report when the verdict passes', async () => {
    const { ports, rec } = harness({ verify: () => Promise.resolve(makeRun(RunFlowStatus.PASS)) });
    await runVerify(ARGS, ports);
    expect(rec.exit).toEqual([0]);
    expect(rec.out.join('\n')).toContain('PASS');
    expect(rec.closed).toBe(1);
  });

  it('exits 1 when nothing ran, so CI cannot go green on an empty run', async () => {
    // The case the exit code exists for. A project with no saved flows used to verify "successfully"
    // in seconds and hand CI a zero -- a green build that proved nothing, which is worse than a red
    // one because nobody goes and looks at it.
    const { ports, rec } = harness({ verify: () => Promise.resolve(makeRun(undefined)) });
    await runVerify(ARGS, ports);
    expect(rec.exit).toEqual([1]);
    expect(rec.out.join('\n')).toContain('NOTHING PROVED');
  });

  it('exits 1 when a flow fails', async () => {
    const { ports, rec } = harness({ verify: () => Promise.resolve(makeRun(RunFlowStatus.FAIL)) });
    await runVerify(ARGS, ports);
    expect(rec.exit).toEqual([1]);
    expect(rec.out.join('\n')).toContain('FAIL');
  });

  it('refuses a pass and exits 1 when no session connects (never a silent green)', async () => {
    let verified = false;
    const { ports, rec } = harness({
      sessionReady: () => Promise.resolve(false),
      verify: () => {
        verified = true;
        return Promise.resolve(makeRun(RunFlowStatus.PASS));
      },
    });
    await runVerify(ARGS, ports);
    expect(rec.exit).toEqual([1]);
    expect(verified).toBe(false);
    expect(rec.fail.join('\n')).toContain('No app connected');
    expect(rec.closed).toBe(1);
  });

  it('refuses a pass and exits 1 when there are zero saved flows (no false green)', async () => {
    let verified = false;
    const { ports, rec } = harness({
      listFlows: () => Promise.resolve([]),
      verify: () => {
        verified = true;
        return Promise.resolve(makeRun(undefined));
      },
    });
    await runVerify(ARGS, ports);
    expect(rec.exit).toEqual([1]);
    expect(verified).toBe(false);
    expect(rec.fail.join('\n')).toContain('No saved flows');
  });

  it('exits 1 and reports when booting the engine throws', async () => {
    const rec = { out: [] as string[], fail: [] as string[], exit: [] as number[] };
    const ports: VerifyPorts = {
      connect: () => Promise.reject(new Error('chromium not found')),
      out: (line) => rec.out.push(line),
      fail: (line) => rec.fail.push(line),
      exit: (code) => rec.exit.push(code),
      cloud: () => Promise.resolve(null),
    };
    await runVerify(ARGS, ports);
    expect(rec.exit).toEqual([1]);
    expect(rec.fail.join('\n')).toContain('chromium not found');
  });

  it('exits 1 when replay throws mid-run and still closes the connection', async () => {
    const { ports, rec } = harness({ verify: () => Promise.reject(new Error('replay boom')) });
    await runVerify(ARGS, ports);
    expect(rec.exit).toEqual([1]);
    expect(rec.fail.join('\n')).toContain('replay boom');
    expect(rec.closed).toBe(1);
  });
});

/**
 * `reticle verify` boots its OWN daemon on the port the app dials, so on a machine where a daemon is
 * already running — which is every machine with Reticle set up — binding fails.
 *
 * It failed by dying: the listen error surfaces asynchronously on the server object, so nothing
 * caught it and the process printed a raw `node:net` EADDRINUSE stack. The source comment beside the
 * bind already knew ("crashed with EADDRINUSE on any machine already running a daemon — i.e. every
 * developer machine") and the remedy taken was to honour an environment variable, which helps only
 * somebody who already knows to set it.
 *
 * It matters more now than it did: the skill advertises this command as the way to get a verdict
 * with no MCP at all, so it is reached by people with the fewest other options.
 *
 * A stack trace is the worst possible answer here. Refusing with the reason and a way out is the
 * least this can do, and it is what the assertion below pins.
 */
describe('verify against a port a daemon already owns', () => {
  it('refuses with a reason instead of a raw listen error', () => {
    const message = portBusyMessage(4400);
    expect(message, 'names the port').toContain('4400');
    expect(message.toLowerCase(), 'says who has it').toMatch(/daemon|already/);
    expect(message, 'gives a way out').toMatch(/reticle stop|RETICLE_PORT|verify_change/);
    expect(message, 'never a bare node error').not.toMatch(/EADDRINUSE|node:net/);
  });
});

describe('exploring an app that has no saved flows', () => {
  /** A project with nothing saved, that gains whatever the drive records. */
  function emptyThenSaved(saved: readonly string[]): Partial<VerifyConnection> {
    let flows: readonly string[] = [];
    return {
      listFlows: () => Promise.resolve([...flows]),
      explore: () => {
        flows = saved;
        return Promise.resolve({ savedFlows: saved, steps: 7 });
      },
    };
  }

  it('drives the app, then verifies what it recorded', async () => {
    const { ports, rec } = harness(emptyThenSaved(['checkout']));

    await runVerify(EXPLORING, ports);

    expect(rec.verifyCalls).toBe(1);
    expect(rec.exit).toEqual([0]);
    expect(rec.out.join('\n')).toContain('checkout');
  });

  it('never drives unasked, because a drive spends money and really clicks things', async () => {
    let drives = 0;
    const { ports, rec } = harness({
      listFlows: () => Promise.resolve([]),
      explore: () => {
        drives += 1;
        return Promise.resolve({ savedFlows: ['x'], steps: 1 });
      },
    });

    await runVerify(ARGS, ports);

    expect(drives).toBe(0);
    expect(rec.exit).toEqual([1]);
  });

  it('does not drive a project that already has flows — replay is the cheap path', async () => {
    let drives = 0;
    const { ports, rec } = harness({
      listFlows: () => Promise.resolve(['checkout']),
      explore: () => {
        drives += 1;
        return Promise.resolve({ savedFlows: [], steps: 1 });
      },
    });

    await runVerify(EXPLORING, ports);

    expect(drives).toBe(0);
    expect(rec.exit).toEqual([0]);
  });

  it('refuses a pass when the drive recorded nothing, however much it cost', async () => {
    const { ports, rec } = harness({
      listFlows: () => Promise.resolve([]),
      explore: () => Promise.resolve({ savedFlows: [], steps: 40 }),
    });

    await runVerify(EXPLORING, ports);

    expect(rec.verifyCalls).toBe(0);
    expect(rec.exit).toEqual([1]);
    expect(rec.fail.join('\n')).toContain('Nothing was proved');
  });

  it('says how to make exploring available when the project is not on the platform', async () => {
    const { ports, rec } = harness({ listFlows: () => Promise.resolve([]) });

    await runVerify(EXPLORING, ports);

    expect(rec.exit).toEqual([1]);
    expect(rec.fail.join('\n')).toContain('reticle connect');
  });

  it('drives as the persona it was given', async () => {
    let focus: string | undefined;
    const { ports } = harness({
      listFlows: () => Promise.resolve([]),
      explore: (who) => {
        focus = who;
        return Promise.resolve({ savedFlows: [], steps: 1 });
      },
    });

    await runVerify({ ...ARGS, persona: 'a returning customer with a full basket' }, ports);

    expect(focus).toBe('a returning customer with a full basket');
  });
});

describe('verifying a subset', () => {
  it('names the label that matched nothing, rather than reporting an empty suite as done', async () => {
    // A typo must not become a green pass over zero flows, and it must not send somebody to record
    // a flow they already have — which is what the generic no-flows refusal would have said.
    const { ports, rec } = harness({ listFlows: () => Promise.resolve([]) });

    await runVerify({ ...ARGS, select: ['smoek'] }, ports);

    expect(rec.exit).toEqual([1]);
    expect(rec.verifyCalls).toBe(0);
    expect(rec.fail.join('\n')).toContain('smoek');
    expect(rec.fail.join('\n')).toContain('nothing was proved');
  });

  it('passes the selection to the connection, which is the only thing that can read a label', async () => {
    let asked: readonly string[] | undefined;
    const { ports, rec } = harness({
      listFlows: (select) => {
        asked = select;
        return Promise.resolve(['checkout']);
      },
    });

    await runVerify({ ...ARGS, select: ['money'] }, ports);

    expect(asked).toEqual(['money']);
    expect(rec.exit).toEqual([0]);
  });
});
/**
 * `reticle verify` read the platform credential from the environment only, so a repo that had
 * run `reticle link` and exported nothing never had its run pushed. It now asks the same resolver
 * every other caller does, handed in as a port.
 */
describe('the run is pushed with the linked credential', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pushes to the linked platform with the stored key when nothing is exported', async () => {
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    vi.stubGlobal('fetch', (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, auth: init.headers['authorization'] });
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    const { ports } = harness({});
    await runVerify(ARGS, {
      ...ports,
      cloud: () => Promise.resolve({ url: 'https://cloud.test', apiKey: 'rk_live_stored' }),
    });
    expect(calls).toContainEqual({
      url: 'https://cloud.test/v1/runs',
      auth: 'Bearer rk_live_stored',
    });
  });
});

describe('the HTTP transport is named wherever --expect refuses', () => {
  it('CLI_USAGE and the daemon-needed refusal both point at http-transport', () => {
    expect(CLI_USAGE).toContain('http-transport');
    expect(expectNeedsDaemonMessage(4400, PortPresence.FOREIGN)).toContain('http-transport');
  });
});

describe('runVerify --results-json', () => {
  it('writes one verdict per journey, the engine words unchanged, beside the report', async () => {
    const { ports, rec } = harness({ verify: () => Promise.resolve(makeRun(RunFlowStatus.FAIL)) });
    const written: { path: string; text: string }[] = [];
    ports.writeResults = (path, text) => {
      written.push({ path, text });
      return Promise.resolve();
    };
    await runVerify({ ...ARGS, resultsJson: 'out.json' }, ports);
    expect(rec.exit).toEqual([1]);
    expect(written.map((w) => w.path)).toEqual(['out.json']);
    expect(JSON.parse(written[0]?.text ?? '{}')).toEqual({
      verdict: 'no',
      results: [{ journey: 'checkout', verdict: 'no', reason: 'order never saved' }],
    });
  });

  it('reads a skipped journey as unknown, and the run as unknown rather than yes', () => {
    const run = makeRun(RunFlowStatus.SKIPPED);
    expect(verifyResults(run)).toEqual({
      verdict: 'unknown',
      results: [{ journey: 'checkout', verdict: 'unknown' }],
    });
    expect(verifyResults(makeRun(RunFlowStatus.PASS)).verdict).toBe('yes');
  });
});
