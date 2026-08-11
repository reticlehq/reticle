import { describe, expect, it } from 'vitest';
import { CrashPort } from '@reticlehq/core';
import { crashCause, innermostInternalFrame } from './crash-cause.js';

/** The real thing, captured from `net.connect(1, '127.0.0.1')` on Node 22. */
function refusedLoopback(port: number): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException & { address?: string; port?: number } = Object.assign(
    new Error(`connect ECONNREFUSED 127.0.0.1:${String(port)}`),
    { syscall: 'connect', code: 'ECONNREFUSED', errno: -61, address: '127.0.0.1', port },
  );
  error.stack = `Error: connect ECONNREFUSED 127.0.0.1:${String(port)}\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1637:16)`;
  return error;
}

const KNOWN = [4400];

describe('crashCause — a location for a stack that has none', () => {
  it('names the syscall and the errno', () => {
    const cause = crashCause(refusedLoopback(4400), KNOWN);
    expect(cause.syscall).toBe('connect');
    expect(cause.errno).toBe('ECONNREFUSED');
  });

  it('reports loopback, which splits a Reticle lifecycle problem from a network one', () => {
    expect(crashCause(refusedLoopback(4400), KNOWN).loopback).toBe(true);
  });

  it('classifies a port we know as ours, without sending the number', () => {
    const cause = crashCause(refusedLoopback(4400), KNOWN);
    expect(cause.port).toBe(CrashPort.RETICLE);
  });

  it('classifies a port we do not know as other', () => {
    expect(crashCause(refusedLoopback(5432), KNOWN).port).toBe(CrashPort.OTHER);
  });

  it('carries the innermost node-internal frame, which names Node source and nothing else', () => {
    expect(crashCause(refusedLoopback(4400), KNOWN).internalFrame).toBe('node:net:1637');
  });

  it('sends nothing at all for an ordinary error with no system-error properties', () => {
    expect(crashCause(new Error('something broke'), KNOWN)).toEqual({});
  });

  it('sends nothing for a non-error value', () => {
    expect(crashCause('a string', KNOWN)).toEqual({});
  });

  /** The half that needs a test, because a telemetry regression is silent and about someone else. */
  it('never carries the address or the port number anywhere in its output', () => {
    const serialized = JSON.stringify(crashCause(refusedLoopback(4400), KNOWN));
    expect(serialized).not.toContain('127.0.0.1');
    expect(serialized).not.toContain('4400');
  });

  it('reports an off-box refusal as not loopback', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:443'), {
      syscall: 'connect',
      code: 'ECONNREFUSED',
      address: '10.0.0.5',
      port: 443,
    });
    expect(crashCause(error, KNOWN).loopback).toBe(false);
  });

  it('treats IPv6 loopback as loopback', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED ::1:4400'), {
      syscall: 'connect',
      code: 'ECONNREFUSED',
      address: '::1',
      port: 4400,
    });
    expect(crashCause(error, KNOWN).loopback).toBe(true);
  });
});

describe('innermostInternalFrame', () => {
  it('finds the node-internal frame in an all-internal stack', () => {
    expect(
      innermostInternalFrame(
        'Error: connect ECONNREFUSED\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1637:16)',
      ),
    ).toBe('node:net:1637');
  });

  it('takes the INNERMOST when several node frames are present', () => {
    expect(
      innermostInternalFrame(
        'Error: x\n    at a (node:dns:120:9)\n    at b (node:net:1637:16)',
      ),
    ).toBe('node:dns:120');
  });

  it('ignores a frame from the user application', () => {
    expect(
      innermostInternalFrame('Error: x\n    at doCheckout (/Users/ada/secret-app/src/checkout.tsx:42:9)'),
    ).toBeUndefined();
  });

  it('returns nothing for a stack with no frames', () => {
    expect(innermostInternalFrame('Error: x')).toBeUndefined();
  });
});

describe('internalFrame is a fallback, not a default', () => {
  /** A crash inside our own code already has a location; it does not need Node's. */
  it('is omitted when Reticle frames are present', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4400'), {
      syscall: 'connect',
      code: 'ECONNREFUSED',
      address: '127.0.0.1',
      port: 4400,
    });
    error.stack =
      'Error: connect ECONNREFUSED\n' +
      '    at startMcpProxy (/x/node_modules/@reticlehq/server/dist/mcp/proxy.js:88:3)\n' +
      '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1637:16)';
    const cause = crashCause(error, KNOWN);
    expect(cause.internalFrame).toBeUndefined();
    expect(cause.syscall).toBe('connect');
  });
});
