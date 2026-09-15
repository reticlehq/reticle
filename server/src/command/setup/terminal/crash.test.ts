import { describe, expect, it } from 'vitest';
import { stopOnCrash, type CrashTarget } from './crash.js';

/**
 * The behaviour this restores, and how it went missing.
 *
 * `setup/reticle.mjs` — the prototype `init`'s runtime phase was ported from — caught its own
 * `uncaughtException` and `unhandledRejection`, stopped the dev server it had started, wrote the
 * trace to a FILE, and left one sentence behind. The break-matrix scenario
 * `a-bug-of-our-own-is-not-a-stack-trace` was written for exactly that, and it ran green for as
 * long as it pointed at the prototype.
 *
 * It was never ported. Injecting a fault into the shipped CLI dumps a raw Node stack trace and
 * leaves the dev server it started running behind it — the precise failure the scenario exists to
 * prevent, passing the whole time because the gate was aimed at code no user runs.
 *
 * The trace goes to a file and never to stdout or stderr: "no stack trace reaches the user" is an
 * invariant every scenario in the matrix asserts, and it stops being checkable the moment we make
 * an exception for our own crashes, which is when it matters most.
 */
function fakeTarget(): CrashTarget & {
  handlers: Map<string, Array<(err: unknown) => void>>;
  exited: number[];
} {
  const handlers = new Map<string, Array<(err: unknown) => void>>();
  const exited: number[] = [];
  return {
    handlers,
    exited,
    on: (event, fn) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    off: (event, fn) => {
      handlers.set(
        event,
        (handlers.get(event) ?? []).filter((h) => h !== fn),
      );
    },
    exit: (code) => void exited.push(code),
  };
}

interface Reported {
  message: string;
  stack: string;
}

function harness() {
  const target = fakeTarget();
  const stopped: number[] = [];
  const reported: Reported[] = [];
  const release = stopOnCrash(
    () => void stopped.push(1),
    target,
    (message, stack) => void reported.push({ message, stack }),
  );
  const fire = (event: 'uncaughtException' | 'unhandledRejection', err: unknown): void => {
    for (const h of target.handlers.get(event) ?? []) h(err);
  };
  return { target, stopped, reported, release, fire };
}

describe('a bug of our own is one sentence and a tidy machine', () => {
  it('stops the dev server it started, rather than leaving it holding a port', () => {
    const { stopped, fire } = harness();
    fire('uncaughtException', new Error('injected internal fault'));
    expect(stopped).toEqual([1]);
  });

  it('catches a rejected promise too, which is the commoner shape of our own bugs', () => {
    const { stopped, fire } = harness();
    fire('unhandledRejection', new Error('nobody awaited this'));
    expect(stopped).toEqual([1]);
  });

  it('reports ONE line of the message, and keeps the stack for the file', () => {
    const { reported, fire } = harness();
    const err = new Error('injected internal fault');
    err.stack = 'Error: injected internal fault\n    at somewhere\n    at somewhere-else';
    fire('uncaughtException', err);

    expect(reported[0]?.message).toBe('injected internal fault');
    expect(reported[0]?.message).not.toContain('\n');
    expect(reported[0]?.stack).toContain('at somewhere');
  });

  it('caps a hostile message rather than printing a page of it', () => {
    const { reported, fire } = harness();
    fire('uncaughtException', new Error('x'.repeat(5000)));
    expect(reported[0]?.message.length).toBeLessThanOrEqual(300);
  });

  it('survives something thrown that is not an Error at all', () => {
    const { reported, stopped, fire } = harness();
    fire('uncaughtException', 'a bare string');
    expect(stopped).toEqual([1]);
    expect(reported[0]?.message).toBe('a bare string');
  });

  it('leaves with a failure code, so a caller cannot read the crash as success', () => {
    const { target, fire } = harness();
    fire('uncaughtException', new Error('boom'));
    expect(target.exited).toEqual([1]);
  });

  // `stop` kills a process GROUP, and on a recycled pid a second kill is somebody else's process.
  it('stops the server once even if both handlers fire', () => {
    const { stopped, fire } = harness();
    fire('uncaughtException', new Error('first'));
    fire('unhandledRejection', new Error('second'));
    expect(stopped).toEqual([1]);
  });

  // Same contract as stopOnInterrupt: init keeps running after setup, and a handler left behind
  // would tear down a server it no longer owns.
  it('releases its handlers, so it cannot outlive the server it owns', () => {
    const { target, stopped, release, fire } = harness();
    release();
    fire('uncaughtException', new Error('after release'));
    expect(stopped).toEqual([]);
    expect(target.handlers.get('uncaughtException') ?? []).toEqual([]);
  });
});
