import { describe, expect, it } from 'vitest';
import {
  RunAgentKind,
  RunFlowStatus,
  RunFramework,
  RunProfile,
  RunTrigger,
  type ReticleVerificationRun,
} from '@reticlehq/core';
import { buildVerificationRun, type VerificationRunInput } from '../runs/build-verification-run.js';
import {
  portBusyMessage,
  runVerify,
  urlParts,
  type VerifyConnection,
  type VerifyPorts,
} from './cli-verify.js';

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
  };
  const ports: VerifyPorts = {
    connect: () => Promise.resolve(connection),
    out: (line) => rec.out.push(line),
    fail: (line) => rec.fail.push(line),
    exit: (code) => rec.exit.push(code),
  };
  return { ports, rec };
}

const ARGS = { url: 'http://localhost:3000', timeoutMs: 1000 };

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

  it('passes the selected session id to flow replay', async () => {
    let selectedSessionId: string | undefined;
    const { ports } = harness({
      verify: (sessionId?: string) => {
        selectedSessionId = sessionId;
        return Promise.resolve(makeRun(RunFlowStatus.PASS));
      },
    });
    await runVerify({ ...ARGS, sessionId: 's2' }, ports);
    expect(selectedSessionId).toBe('s2');
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
