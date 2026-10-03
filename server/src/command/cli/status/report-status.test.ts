import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reportStatus } from '../../cli.js';

describe('reportStatus --json writes to stdout, not stderr (#1277)', () => {
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  let stdoutBuf: string;
  let stderrBuf: string;

  beforeEach(() => {
    stdoutBuf = '';
    stderrBuf = '';
    process.stdout.write = (chunk: unknown) => {
      stdoutBuf += String(chunk);
      return true;
    };
    process.stderr.write = (chunk: unknown) => {
      stderrBuf += String(chunk);
      return true;
    };
  });

  afterEach(() => {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  });

  it('writes exactly one JSON line to stdout', () => {
    reportStatus({ port: 4400, running: true }, true);
    expect(stdoutBuf).toContain('"event":"reticle_status"');
    expect(stdoutBuf).toContain('"port":4400');
    expect(stdoutBuf).toContain('"running":true');
    const lines = stdoutBuf.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(() => {
      JSON.parse(lines[0] ?? '');
    }).not.toThrow();
  });

  it('does not write JSON to stderr', () => {
    reportStatus({ port: 4400, running: true }, true);
    expect(stderrBuf).toBe('');
  });

  it('plain mode still writes to stdout', () => {
    reportStatus({ port: 4400, running: true }, false);
    expect(stdoutBuf).toContain('reticle status');
    expect(stderrBuf).toBe('');
  });
});
