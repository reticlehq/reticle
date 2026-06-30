import { describe, expect, it } from 'vitest';
import {
  RunAgentKind,
  RunFlowStatus,
  RunFramework,
  RunProfile,
  RunTrigger,
  type ReticleVerificationRun,
} from '@reticlehq/protocol';
import { buildVerificationRun, type VerificationRunInput } from './runs/build-verification-run.js';
import { runVerify, urlParts, type VerifyConnection, type VerifyPorts } from './cli-verify.js';

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
