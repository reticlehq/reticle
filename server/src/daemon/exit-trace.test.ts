import { beforeEach, describe, expect, it } from 'vitest';
import { installExitTrace, recordExitReason, DaemonExitReason } from './daemon-resilience.js';

/**
 * A daemon that dies must leave a line saying so.
 *
 * Reported from the field: a 115-line log with zero of `reticle_daemon_idle_exit`,
 * `reticle_daemon_close_error`, `daemon_stopped`, `uncaught` or `unhandled`. The crash handlers all
 * log before exiting, so their silence ruled them out and left nothing else to read — the daemon
 * stopped existing mid-wait and no shutdown path had run.
 *
 * With every in-process door instrumented, the NEXT occurrence is decisive either way: a line names
 * the exit, or the absence of one narrows it to SIGKILL / OOM, which nothing in-process can log.
 */
const wire = () => {
  const handlers = new Map<string, (arg: unknown) => void>();
  const logged: { event: string; data: Record<string, unknown> }[] = [];
  installExitTrace(
    {
      on(event: string, listener: (arg: unknown) => void) {
        handlers.set(event, listener);
        return undefined;
      },
    },
    (event, data) => void logged.push({ event, data }),
  );
  return { handlers, logged };
};

describe('installExitTrace — every door out is instrumented', () => {
  it('logs the exit code on a normal or explicit exit', () => {
    const { handlers, logged } = wire();
    handlers.get('exit')?.(0);
    expect(logged).toEqual([
      { event: 'reticle_daemon_exiting', data: { code: 0, reason: DaemonExitReason.UNKNOWN } },
    ]);
  });

  it('carries a non-zero code, which is what distinguishes a crash from a clean stop', () => {
    const { handlers, logged } = wire();
    handlers.get('exit')?.(1);
    expect(logged[0]?.data['code']).toBe(1);
  });

  it('names the signal on an external kill', () => {
    const { handlers, logged } = wire();
    handlers.get('SIGTERM')?.(undefined);
    expect(logged).toEqual([{ event: 'reticle_daemon_signalled', data: { signal: 'SIGTERM' } }]);
  });

  it('covers the signals a supervisor or shell actually sends', () => {
    const { handlers } = wire();
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      expect(handlers.has(signal), `${signal} must be traced`).toBe(true);
    }
  });

  it('does not exit on a signal — the real shutdown still needs to flush', () => {
    const { handlers, logged } = wire();
    handlers.get('SIGINT')?.(undefined);
    // Only a log. Exiting here would race the shutdown that sends the session summary.
    expect(logged).toHaveLength(1);
  });
});

/**
 * `code: 0` is the last line before the port goes dark, and it does not say why.
 *
 * From #123, a real gate log:
 *
 *   10:51:40  reticle_daemon_signalled  SIGTERM
 *   10:51:40  reticle_daemon_exiting    code:0
 *             ... 21 seconds with nothing listening ...
 *
 * A reader cannot tell "the daemon shut down tidily" from "the bridge every app on this machine
 * needs is now gone". The consequence was not academic: a CORRECT install was written up as a
 * failure naming the fixture — `sveltekit` reported as "app booted but NO session appeared" when
 * the daemon simply was not there.
 *
 * `heartbeat.ts:25` states the gap outright: the signal event is "a CAUSE the exit line does not
 * carry". Correlating two lines is possible and is exactly the inference the issue says a reader
 * should not have to make.
 *
 * `unknown` is load-bearing rather than a fallback: it means the process left through Node WITHOUT
 * going through a shutdown path — an uncaught throw, a stray `process.exit`. That is a different
 * fact from an idle exit, and the one worth noticing.
 */
describe('the exit line names WHY, not just the code', () => {
  // The reason is module state by design (see recordExitReason), so tests must not inherit each
  // other's. Reset explicitly rather than relying on declaration order, which is the kind of
  // dependency that passes locally and reorders in CI.
  beforeEach(() => {
    recordExitReason(DaemonExitReason.UNKNOWN);
  });

  it('says unknown when nothing recorded a reason — the process left by some other door', () => {
    const { handlers, logged } = wire();
    handlers.get('exit')?.(0);
    expect(logged[0]?.data['reason']).toBe('unknown');
  });

  it('carries the reason a shutdown path recorded', () => {
    const { handlers, logged } = wire();
    recordExitReason(DaemonExitReason.IDLE);
    handlers.get('exit')?.(0);
    expect(logged[0]?.data['reason']).toBe(DaemonExitReason.IDLE);
    expect(logged[0]?.data['code']).toBe(0);
  });

  it('distinguishes a signal from an idle timeout', () => {
    const { handlers, logged } = wire();
    recordExitReason(DaemonExitReason.SIGNAL);
    handlers.get('exit')?.(0);
    expect(logged[0]?.data['reason']).toBe(DaemonExitReason.SIGNAL);
    expect(logged[0]?.data['reason']).not.toBe(DaemonExitReason.IDLE);
  });
});
