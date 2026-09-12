import { describe, expect, it } from 'vitest';
import { BrowserLaunchKind, ConnectFailure } from '@reticlehq/core/telemetry';
import { SessionMetrics } from './session-metrics.js';
import {
  errorSkeleton,
  fingerprintCrash,
  fingerprintError,
  reticleFrames,
} from './error-fingerprint.js';

const clock = (start = 0): (() => number) => {
  let t = start;
  return () => (t += 1000);
};

describe('SessionMetrics — one event instead of hundreds', () => {
  it('rolls tool calls into a histogram rather than a stream of events', () => {
    const m = new SessionMetrics(clock());
    m.recordToolCall('reticle_act');
    m.recordToolCall('reticle_act');
    m.recordToolCall('reticle_assert');
    const summary = m.summarize(true);
    expect(summary.toolCalls).toBe(3);
    expect(summary.toolCounts).toEqual({ reticle_act: 2, reticle_assert: 1 });
  });

  it('groups errors by FINGERPRINT so the same defect from many machines collapses to one row', () => {
    const m = new SessionMetrics(clock());
    // Same defect, different flow names — the whole reason fingerprints exist.
    m.recordToolError("no baseline named 'checkout-v3'", 'reticle_baseline');
    m.recordToolError("no baseline named 'login'", 'reticle_baseline');
    const errors = m.summarize(true).errors ?? [];
    expect(errors).toHaveLength(1);
    expect(errors[0]?.count).toBe(2);
    expect(m.summarize(true).toolErrors).toBe(2);
  });

  /**
   * A fingerprint alone could be RANKED and never DIAGNOSED — forty machines hitting `a3f2c1d8` with
   * no way to learn what `a3f2c1d8` was. The skeleton is the dictionary entry that makes the group
   * key mean something, and the tool is what separates the same message from two different bugs.
   */
  it('carries a readable skeleton and the tool, not just an opaque hash', () => {
    const m = new SessionMetrics(clock());
    m.recordToolError("no baseline named 'checkout-v3'", 'reticle_baseline');
    const error = (m.summarize(true).errors ?? [])[0];
    expect(error?.message).toBe('no baseline named *');
    expect(error?.tool).toBe('reticle_baseline');
    expect(error?.message).not.toContain('checkout-v3');
    expect(error?.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it('remembers the recent approach run, so a crash can say what the agent was doing', () => {
    const m = new SessionMetrics(clock());
    m.recordToolCall('reticle_snapshot');
    m.recordToolCall('reticle_act');
    m.recordToolCall('reticle_assert');
    expect(m.trail.breadcrumb).toEqual(['reticle_snapshot', 'reticle_act', 'reticle_assert']);
    expect(m.trail.inFlight).toBe('reticle_assert');
  });

  it('bounds the breadcrumb to the recent past rather than the whole session', () => {
    const m = new SessionMetrics(clock());
    for (let i = 0; i < 50; i += 1) m.recordToolCall(`reticle_tool_${i}`);
    expect(m.trail.breadcrumb.length).toBeLessThanOrEqual(12);
    expect(m.trail.breadcrumb.at(-1)).toBe('reticle_tool_49');
  });

  it('bounds the distinct error shapes it will hold, so a pathological loop cannot grow memory', () => {
    const m = new SessionMetrics(clock());
    for (let i = 0; i < 500; i += 1)
      m.recordToolError(`unique failure kind ${String.fromCharCode(i)}`);
    expect((m.summarize(true).errors ?? []).length).toBeLessThanOrEqual(40);
  });

  /**
   * The first version of this counted only successes — and counted them INCONSISTENTLY, incrementing
   * before the await on the CDP path and after it on the launch path, so one number meant attempts
   * and the others meant successes and nothing in the data said which. A connection metric that
   * cannot express failure misses the only question worth asking: how often can people not get a
   * browser?
   */
  it('counts attempts AND successes, so a failure is visible rather than absent', () => {
    const m = new SessionMetrics(clock());
    m.recordConnectAttempt(BrowserLaunchKind.LAUNCHED)();
    m.recordConnectAttempt(BrowserLaunchKind.POOLED)();
    m.recordConnectAttempt(BrowserLaunchKind.POOLED)(ConnectFailure.CHROMIUM_MISSING);
    const connections = m.summarize(true).connections ?? {};
    expect(connections['launched']).toEqual({ attempts: 1, successes: 1 });
    expect(connections['pooled']).toEqual({
      attempts: 2,
      successes: 1,
      failures: { chromium_missing: 1 },
    });
  });

  it('never double-settles a connection, however many times the closure is called', () => {
    const m = new SessionMetrics(clock());
    const settle = m.recordConnectAttempt(BrowserLaunchKind.LAUNCHED);
    settle();
    settle();
    settle(ConnectFailure.OTHER);
    expect(m.summarize(true).connections?.['launched']).toEqual({ attempts: 1, successes: 1 });
  });

  it('times each tool, keeping the worst call as well as the total', () => {
    const m = new SessionMetrics(clock());
    m.startToolCall('reticle_act')(120);
    m.startToolCall('reticle_act')(880);
    m.startToolCall('reticle_snapshot')(40);
    const summary = m.summarize(true);
    expect(summary.toolTiming?.['reticle_act']).toEqual({ totalMs: 1000, maxMs: 880 });
    // busyMs is the headline "how much time does verification actually cost" number.
    expect(summary.busyMs).toBe(1040);
  });

  /**
   * Timing must survive concurrency: several agents can be inside runTool at once, so a single
   * "last start" field would attribute one tool's duration to another.
   */
  it('measures peak concurrency and settles overlapping calls independently', () => {
    const m = new SessionMetrics(clock());
    const a = m.startToolCall('reticle_act');
    const b = m.startToolCall('reticle_assert');
    const c = m.startToolCall('reticle_query');
    c(10);
    b(20);
    a(30);
    const summary = m.summarize(true);
    expect(summary.peakConcurrentTools).toBe(3);
    expect(summary.toolTiming?.['reticle_act']?.totalMs).toBe(30);
    expect(summary.toolTiming?.['reticle_query']?.totalMs).toBe(10);
  });

  it('counts calls for tools that do not exist — a naming defect that was invisible', () => {
    const m = new SessionMetrics(clock());
    m.recordUnknownTool();
    m.recordUnknownTool();
    expect(m.summarize(true).unknownToolCalls).toBe(2);
  });

  it('samples the machine, so "out of memory" and "our bug" can be told apart', () => {
    const machine = new SessionMetrics(clock()).summarize(true).machine;
    expect(machine?.totalMemMb).toBeGreaterThan(0);
    expect(machine?.cpuCount).toBeGreaterThan(0);
    expect(machine?.rssMb).toBeGreaterThan(0);
  });

  it('reports empty for an idle daemon, so a periodic flush sends nothing', () => {
    const m = new SessionMetrics(clock());
    expect(m.empty).toBe(true);
    m.recordToolCall('reticle_snapshot');
    expect(m.empty).toBe(false);
  });

  it('reset zeroes the window so a non-final flush reports the NEXT window, not a running total', () => {
    const m = new SessionMetrics(clock());
    m.recordToolCall('reticle_act');
    m.reset();
    const after = m.summarize(false);
    expect(after.toolCalls).toBe(0);
    expect(after.toolCounts).toEqual({});
    expect(after.final).toBe(false);
  });
});

/**
 * The fingerprint tests are the privacy contract for error analytics: each case is a thing that must
 * NOT survive into the group key, plus the grouping behaviour that makes the key worth having.
 */
describe('error fingerprinting', () => {
  it.each([
    ['a quoted flow name', `no baseline named 'checkout-v3'`, 'checkout-v3'],
    ['a URL', 'failed to reach https://acme.internal/api/orders', 'acme'],
    ['a POSIX path', 'cannot read /Users/ada/work/secret-app/src/App.tsx', 'ada'],
    ['a Windows path', 'cannot read C:\\Users\\Ada\\app\\main.ts', 'Ada'],
    ['a uuid', 'session 3f2504e0-4f89-11d3-9a0c-0305e82c3301 is gone', '3f2504e0'],
  ])('strips %s out of the skeleton', (_label, message, secret) => {
    expect(errorSkeleton(message)).not.toContain(secret);
  });

  it('gives the same key to the same defect and different keys to different ones', () => {
    expect(fingerprintError("no baseline named 'a'")).toBe(
      fingerprintError("no baseline named 'b'"),
    );
    expect(fingerprintError('no baseline named "a"')).not.toBe(
      fingerprintError('the pool is empty'),
    );
  });

  /**
   * Frames are OUR published code, so they carry the function name and line — which is most of what a
   * root-cause analysis needs. The user's own frames are dropped entirely: those name their app and
   * their home directory, and are none of our business.
   */
  it('keeps only RETICLE frames, as function@basename:line', () => {
    const stack = [
      'TypeError: x is not a function',
      '    at doThing (/Users/ada/secret-app/src/checkout.tsx:42:9)',
      '    at Object.resolveAnchor (/home/ada/p/node_modules/@reticlehq/server/dist/tools/act-tools.js:88:3)',
      '    at async run (/home/ada/p/node_modules/@reticlehq/server/dist/tools/invoke-tool.js:12:1)',
      '    at node:internal/process/task_queues:95:5',
    ].join('\n');
    const frames = reticleFrames(stack);
    // `Object.` is V8 noise that would make one function look like two.
    expect(frames).toEqual(['resolveAnchor@act-tools.js:88', 'run@invoke-tool.js:12']);
    expect(frames.join()).not.toContain('checkout');
    expect(frames.join()).not.toContain('ada');
  });

  it('still fingerprints a crash with no Reticle frames, rather than dropping it', () => {
    const fp = fingerprintCrash('TypeError', 'at /somewhere/else.js:1:1', 'boom on port 3000');
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
    // Port numbers vary per machine; the same crash must still group.
    expect(fp).toBe(
      fingerprintCrash('TypeError', 'at /somewhere/else.js:1:1', 'boom on port 4400'),
    );
  });
});

/**
 * Distinct defects vs defect instances.
 *
 * `bug_found` fires once per occurrence, so a defect hit five times in a session is five events.
 * That is the right raw signal — how often users actually collide with a class of defect — but it
 * cannot answer "how many distinct defects did Reticle find", which is the number that would go in
 * front of anyone. Counting instances as defects inflates the claim; counting only distinct ones
 * throws away frequency. Both are needed, so the event carries which it is.
 *
 * Firstness is tracked in its own uncapped set rather than read off `#bugKinds`. That map is capped
 * at MAX_ERROR_KINDS, and once full a genuinely new kind is never inserted — so `has()` would answer
 * "not seen" forever and mark every later occurrence as first, inflating the distinct count exactly
 * where the data got interesting. The kind vocabulary is bounded and small; the set is not a leak.
 */
describe('recordBug reports whether this KIND is new to the session', () => {
  it('is first on the first occurrence and a repeat thereafter', () => {
    const m = new SessionMetrics(clock());
    expect(m.recordBug('signal-contradicted')).toBe(true);
    expect(m.recordBug('signal-contradicted')).toBe(false);
    expect(m.recordBug('signal-contradicted')).toBe(false);
  });

  it('tracks each kind independently', () => {
    const m = new SessionMetrics(clock());
    expect(m.recordBug('duplicate-request')).toBe(true);
    expect(m.recordBug('unit-mismatch')).toBe(true);
    expect(m.recordBug('duplicate-request')).toBe(false);
  });

  it('still counts every occurrence — firstness never suppresses the instance count', () => {
    const m = new SessionMetrics(clock());
    m.recordBug('stale-response-applied');
    m.recordBug('stale-response-applied');
    const snap = m.summarize(true) as unknown as {
      bugsFound?: number;
      bugKinds?: Record<string, number>;
    };
    expect(snap.bugsFound).toBe(2);
    expect(snap.bugKinds?.['stale-response-applied']).toBe(2);
  });

  it('keeps answering correctly past the kind-map cap, where a naive has() check would not', () => {
    const m = new SessionMetrics(clock());
    for (let i = 0; i < 60; i += 1) m.recordBug(`filler-kind-${String(i)}`);
    expect(m.recordBug('filler-kind-59')).toBe(false);
    expect(m.recordBug('a-genuinely-new-kind')).toBe(true);
    expect(m.recordBug('a-genuinely-new-kind')).toBe(false);
  });

  it('firstness survives a flush — reset() ends a WINDOW, not the session', () => {
    // This used to assert the opposite, which is what shipped the double-count: reset() is the
    // periodic roll-up, and the daemon process is the session. A defect re-found 5 minutes later is
    // the same defect. See session-window.test.ts.
    const m = new SessionMetrics(clock());
    expect(m.recordBug('route-rendered-nothing')).toBe(true);
    m.reset();
    expect(m.recordBug('route-rendered-nothing')).toBe(false);
  });
});

/**
 * A designed exit and a real failure must not be the same row.
 *
 * In the field the large majority of `mcp_connection_lost` events were `sse_ended` at stage `first`
 * — overwhelmingly the daemon closing its own stream on its scheduled idle shutdown. The proxy that
 * emits the outage only ever sees a socket end, so the metric meant to say "the agent lost its
 * tools" was mostly counting the daemon going to sleep on purpose, and a genuine outage was
 * invisible inside it. The daemon has always known the reason; it just never put it on an event.
 */
describe('the session summary says WHY the daemon exited', () => {
  it('carries the exit reason on a final summary', () => {
    const metrics = new SessionMetrics(() => 0);
    expect(metrics.summarize(true, 'idle').exit).toBe('idle');
    expect(metrics.summarize(true, 'signal').exit).toBe('signal');
  });

  it('omits `exit` on a periodic flush — nothing exited', () => {
    // A flush carrying `exit: "unknown"` would read as a daemon that died without a shutdown path,
    // which is the one thing this field exists to make visible.
    const metrics = new SessionMetrics(() => 0);
    expect(metrics.summarize(false, 'idle')).not.toHaveProperty('exit');
  });

  it('omits `exit` when no reason was given — absent beats a guess', () => {
    const metrics = new SessionMetrics(() => 0);
    expect(metrics.summarize(true)).not.toHaveProperty('exit');
  });
});

/**
 * The FINAL summary must describe the session, not the residue after the last flush.
 *
 * `reset()` zeroes every window counter on each periodic flush; `durationMs` is measured from
 * `#startedAt` and never resets. So `daemon_stopped` — the event whose docstring promises "the whole
 * session in a single event" — described a long session that made no calls.
 *
 * In the field almost every `daemon_stopped` row carried `toolCalls: 0`, at a median
 * duration of 30.5 minutes, while `session_progress` for the same daemons carried real histograms.
 * Every funnel computed off the end-of-session event therefore read zero at the exact step this
 * release exists to raise.
 */
describe('a final summary reports the whole session, not the last window', () => {
  it('counts tool calls made BEFORE a flush', () => {
    const m = new SessionMetrics(() => 0);
    m.recordToolCall('reticle_act');
    m.recordToolCall('reticle_act');
    m.reset(); // the periodic flush

    expect(m.summarize(true).toolCalls, 'this read 0 for two days').toBe(2);
  });

  it('still reports the WINDOW on a periodic flush, so summing those does not double-count', () => {
    const m = new SessionMetrics(() => 0);
    m.recordToolCall('reticle_act');
    m.reset();
    m.recordToolCall('reticle_query');

    expect(m.summarize(false).toolCalls, 'window semantics must not change').toBe(1);
    expect(m.summarize(true).toolCalls, 'lifetime on the final event').toBe(2);
  });

  it('does the same for verifications — the number this release is measured by', () => {
    const m = new SessionMetrics(() => 0);
    m.recordVerification();
    m.reset();

    expect(m.summarize(true).verifications).toBe(1);
  });

  it('does the same for tool errors and bugs found', () => {
    const m = new SessionMetrics(() => 0);
    m.recordToolError('boom', 'reticle_act');
    m.recordBug('assertion-failed');
    m.reset();

    const final = m.summarize(true);
    expect(final.toolErrors).toBe(1);
    expect(final.bugsFound).toBe(1);
  });

  it('never reports a session that acted as having made no calls', () => {
    // The internally inconsistent row: a non-zero duration next to a zero count.
    let t = 0;
    const m = new SessionMetrics(() => t);
    m.recordToolCall('reticle_snapshot');
    t = 30 * 60 * 1000;
    m.reset();

    const final = m.summarize(true);
    expect(final.durationMs).toBeGreaterThan(0);
    expect(final.toolCalls, 'duration and counts must describe the same span').toBeGreaterThan(0);
  });
});

/**
 * Ask for a verdict when the agent has driven the page and not asked for one.
 *
 * In the field, sessions split cleanly in two: the ones that produced a verdict called
 * `act_and_wait` and `assert` freely, and the ones that did not almost never called either tool
 * even once. **Verdict-less sessions drove the app with `reticle_act` and never asked whether it
 * worked.** The product already counted this (`abandonedActions`) and never told the agent.
 *
 * One-shot per session, like the pool lease: a hint repeated every call is noise that gets tuned
 * out, and every byte here is paid on a live tool result.
 */
describe('the agent is asked for a verdict once it has acted without one', () => {
  const drive = (m: SessionMetrics, n: number) => {
    for (let i = 0; i < n; i += 1) m.recordAction();
  };

  it('says nothing until enough actions have gone unverified', () => {
    const m = new SessionMetrics(() => 0);
    drive(m, 2);
    expect(m.takeUnverifiedNudge()).toBeUndefined();
  });

  it('asks once the agent has driven three times with no verdict', () => {
    const m = new SessionMetrics(() => 0);
    drive(m, 3);
    const nudge = m.takeUnverifiedNudge();
    expect(nudge).toBeDefined();
    expect(nudge).toContain('reticle_act_and_wait');
    expect(nudge).toContain('reticle_assert');
  });

  it('is ONE-SHOT — a hint on every call is noise', () => {
    const m = new SessionMetrics(() => 0);
    drive(m, 5);
    expect(m.takeUnverifiedNudge()).toBeDefined();
    drive(m, 5);
    expect(m.takeUnverifiedNudge(), 'already said once').toBeUndefined();
  });

  it('never fires for an agent that verifies as it goes', () => {
    // act -> assert -> act -> assert is the loop working. It must not be nagged.
    const m = new SessionMetrics(() => 0);
    for (let i = 0; i < 10; i += 1) {
      m.recordAction();
      m.recordVerification();
    }
    expect(m.takeUnverifiedNudge()).toBeUndefined();
  });

  it('a verdict re-arms it, so a SECOND abandoned run is caught too', () => {
    const m = new SessionMetrics(() => 0);
    drive(m, 3);
    expect(m.takeUnverifiedNudge()).toBeDefined();
    m.recordVerification(); // the agent complied
    drive(m, 3); // ...and then drifted again
    expect(m.takeUnverifiedNudge(), 'the loop broke a second time').toBeDefined();
  });
});

/**
 * Did an app ever connect to this daemon?
 *
 * This is the blind spot that stops us answering the release's central question. `session_progress`
 * only fires when a tool was CALLED, so these two are currently the SAME ROW:
 *
 *   - daemon up, the user's dev server never dialled in  -> the INSTALL is broken
 *   - daemon up, app connected fine, the agent never asked -> the agent didn't think to use it
 *
 * They have opposite fixes. In the field most users who attached an agent never drove, and we
 * cannot say which of those two it was for a single one of them.
 *
 * A counter on the session summary rather than a new event: the SDK reconnects on every page
 * reload, so an event per connect would be high-volume for a question that one number answers.
 */
describe('the session summary says whether an app ever connected', () => {
  it('reports zero when no app ever dialled in — the broken-install signal', () => {
    const m = new SessionMetrics(() => 0);
    expect(m.summarize(true).appConnects).toBe(0);
  });

  it('counts app connections', () => {
    const m = new SessionMetrics(() => 0);
    m.recordAppConnected();
    m.recordAppConnected();
    expect(m.summarize(true).appConnects).toBe(2);
  });

  it('records how long the daemon waited for its first app', () => {
    let t = 0;
    const m = new SessionMetrics(() => t);
    t = 4200;
    m.recordAppConnected();
    t = 9000;
    m.recordAppConnected();
    expect(m.summarize(true).msToFirstApp, 'the FIRST one, not the latest').toBe(4200);
  });

  it('survives a flush — "did an app ever connect" is a session-lifetime fact', () => {
    const m = new SessionMetrics(() => 0);
    m.recordAppConnected();
    m.reset();
    expect(m.summarize(true).appConnects, 'a reload after a flush must not erase this').toBe(1);
  });

  it('omits msToFirstApp entirely when nothing connected', () => {
    const m = new SessionMetrics(() => 0);
    expect(m.summarize(true)).not.toHaveProperty('msToFirstApp');
  });
});

/**
 * The NAME an agent reached for is a feature request in the agent's own vocabulary.
 *
 * `recordUnknownTool()` counted and threw the name away, so a non-zero `unknownToolCalls` said
 * "the surface confused someone" and could never say what they wanted. The name is a NAME — our
 * own vocabulary space, agent-guessed, carrying no app data — so it is safe under the contract
 * rule that sends names and never values.
 *
 * Cheap to collect and it is the only place the product learns what capability an agent expected
 * and could not find.
 */
describe('an unknown tool records WHAT the agent reached for', () => {
  it('keeps the name, not just the count', () => {
    const m = new SessionMetrics(() => 0);
    m.recordUnknownTool('reticle_screenshot_diff');
    const s = m.summarize(true);
    expect(s.unknownToolCalls).toBe(1);
    expect(s.unknownTools).toEqual({ reticle_screenshot_diff: 1 });
  });

  it('counts repeats of the same guess — twice is a stronger signal than once', () => {
    const m = new SessionMetrics(() => 0);
    m.recordUnknownTool('reticle_login');
    m.recordUnknownTool('reticle_login');
    m.recordUnknownTool('reticle_wait');
    expect(m.summarize(true).unknownTools).toEqual({ reticle_login: 2, reticle_wait: 1 });
  });

  it('survives a flush — a guess made early must still be reported at the end', () => {
    const m = new SessionMetrics(() => 0);
    m.recordUnknownTool('reticle_login');
    m.reset();
    expect(m.summarize(true).unknownTools).toEqual({ reticle_login: 1 });
  });

  it('omits the field entirely when nothing was guessed', () => {
    expect(new SessionMetrics(() => 0).summarize(true)).not.toHaveProperty('unknownTools');
  });

  it('still counts an unnamed call, so the old counter never regresses', () => {
    const m = new SessionMetrics(() => 0);
    m.recordUnknownTool();
    expect(m.summarize(true).unknownToolCalls).toBe(1);
    expect(m.summarize(true)).not.toHaveProperty('unknownTools');
  });

  it('is bounded and truncates a long name — a guess is short, a payload is not', () => {
    const m = new SessionMetrics(() => 0);
    m.recordUnknownTool('x'.repeat(500));
    const names = Object.keys(m.summarize(true).unknownTools ?? {});
    expect(names[0]?.length).toBeLessThanOrEqual(64);
  });

  it('stops growing at a cap, so a pathological loop cannot balloon the payload', () => {
    const m = new SessionMetrics(() => 0);
    for (let i = 0; i < 200; i += 1) m.recordUnknownTool(`guess_${String(i)}`);
    expect(Object.keys(m.summarize(true).unknownTools ?? {}).length).toBeLessThanOrEqual(40);
  });
});

/**
 * Which agent drove, and on which build — the dimension that turns every rate into a matrix.
 *
 * For a product whose users are LLM agents, a single global "28% verified" hides the finding.
 * `claude-code` and `cursor` are different users with different failure modes, and a regression is
 * usually a client VERSION.
 *
 * MCP's `clientInfo` has no concept of a model, so the transport genuinely cannot report one — the
 * agent self-reports it on feedback and nowhere else. But the client name AND its version are both
 * in the handshake we already read, and only the name was being kept.
 *
 * `surface` rides along because it is the other thing that changes what an agent sees: the 18-tool
 * default and the 48-tool full surface are different products from inside.
 */
describe('the session records WHICH agent drove it', () => {
  it('keeps the client version, not just the name', () => {
    const m = new SessionMetrics(() => 0);
    m.recordClient('claude-code', '2.1.0');
    const s = m.summarize(true);
    expect(s.clients).toEqual(['claude-code']);
    expect(s.clientVersions).toEqual({ 'claude-code': '2.1.0' });
  });

  it('records several agents on one daemon — the multi-agent story', () => {
    const m = new SessionMetrics(() => 0);
    m.recordClient('claude-code', '2.1.0');
    m.recordClient('cursor', '0.44.1');
    expect(m.summarize(true).clientVersions).toEqual({
      'claude-code': '2.1.0',
      cursor: '0.44.1',
    });
  });

  it('still records a client that reports no version', () => {
    const m = new SessionMetrics(() => 0);
    m.recordClient('some-agent');
    const s = m.summarize(true);
    expect(s.clients).toEqual(['some-agent']);
    expect(s).not.toHaveProperty('clientVersions');
  });

  it('records which tool surface was live', () => {
    const m = new SessionMetrics(() => 0);
    m.recordSurface('default');
    expect(m.summarize(true).surface).toBe('default');
  });

  it('survives a flush — who drove is a session-lifetime fact', () => {
    const m = new SessionMetrics(() => 0);
    m.recordClient('claude-code', '2.1.0');
    m.recordSurface('default');
    m.reset();
    const s = m.summarize(true);
    expect(s.clientVersions).toEqual({ 'claude-code': '2.1.0' });
    expect(s.surface).toBe('default');
  });
});

/**
 * Why the agent's work ended — the question every other number raises and none answers.
 *
 * In the field most agents that drove an app produced no verdict. Whether that
 * is a product failure or a task that simply ended is the difference between a bug and a
 * non-event, and nothing in the payload could tell them apart.
 *
 * Most of it IS derivable at query time from `verifications` / `abandonedActions` / `toolCalls`.
 * The part that is NOT derivable is whether the CLIENT went away or the agent simply stopped
 * asking — one is our problem, the other is the task ending — so that is the part recorded here.
 */
describe('the session says why the work ended', () => {
  it('reports `never_used` when no tool was ever called', () => {
    expect(new SessionMetrics(() => 0).summarize(true).endReason).toBe('never_used');
  });

  it('reports `verified` when the last thing the agent did was get a verdict', () => {
    const m = new SessionMetrics(() => 0);
    m.recordToolCall('reticle_act');
    m.recordAction();
    m.recordVerification();
    expect(m.summarize(true).endReason).toBe('verified');
  });

  it('reports `abandoned` when the agent drove and never asked for a verdict', () => {
    // The 137-of-140 case. An action with nothing settling it is the loop breaking mid-task.
    const m = new SessionMetrics(() => 0);
    m.recordToolCall('reticle_act');
    m.recordAction();
    expect(m.summarize(true).endReason).toBe('abandoned');
  });

  it('reports `client_left` when the agent detached — not our failure to hold its attention', () => {
    const m = new SessionMetrics(() => 0);
    m.recordToolCall('reticle_act');
    m.recordAction();
    m.recordClientLeft();
    expect(m.summarize(true).endReason, 'the client going away outranks an unsettled run').toBe(
      'client_left',
    );
  });

  it('reports `explored` for a session that read but never drove', () => {
    const m = new SessionMetrics(() => 0);
    m.recordToolCall('reticle_snapshot');
    expect(m.summarize(true).endReason).toBe('explored');
  });

  it('is absent on a periodic flush — nothing has ended', () => {
    const m = new SessionMetrics(() => 0);
    m.recordToolCall('reticle_act');
    expect(m.summarize(false)).not.toHaveProperty('endReason');
  });

  /**
   * The headline metric, and the one that was only reachable by subtraction. Every other
   * verification number in the payload is windowed, so the obvious query over `session_progress`
   * answers a different question while looking like it answers this one.
   */
  it('says outright whether the session ever produced a verdict', () => {
    const m = new SessionMetrics(() => 0);
    m.recordToolCall('reticle_act');
    m.recordVerification();
    expect(m.summarize(true).endedWithVerdict).toBe(true);
  });

  it('sends `false` rather than omitting it — a session that never asked IS the finding', () => {
    const m = new SessionMetrics(() => 0);
    m.recordToolCall('reticle_act');
    expect(m.summarize(true).endedWithVerdict).toBe(false);
  });

  /**
   * A verdict earlier in the session still counts at the end of it. `verifications` is zeroed by
   * every flush, so reading the window here would report `false` for a session that verified and
   * then kept working — which is the shape of every long session in the data.
   */
  it('remembers a verdict that happened before a periodic flush', () => {
    const m = new SessionMetrics(() => 0);
    m.recordToolCall('reticle_act');
    m.recordVerification();
    m.reset();
    m.recordToolCall('reticle_snapshot');
    expect(m.summarize(true).endedWithVerdict).toBe(true);
  });

  it('is absent on a periodic flush, which is not the end of anything', () => {
    const m = new SessionMetrics(() => 0);
    m.recordToolCall('reticle_act');
    m.recordVerification();
    expect(m.summarize(false)).not.toHaveProperty('endedWithVerdict');
  });
});

/**
 * Instrument the nudge, not just the product.
 *
 * A feedback invitation on every result is affordable (~12 tokens) but will be tuned out if it is
 * the same string 40 times. `feedbackPrompted` against `feedback_submitted` is the only way to
 * know whether it works — if the ratio is flat, the line is decoration and we delete it.
 *
 * Instrumenting our own nudge is what separates a designed system from a guess.
 */
describe('the feedback invitation is itself measured', () => {
  it('counts how often the agent was invited', () => {
    const m = new SessionMetrics(() => 0);
    m.recordFeedbackPrompt();
    m.recordFeedbackPrompt();
    expect(m.summarize(true).feedbackPrompted).toBe(2);
  });

  it('is absent when nobody was ever invited', () => {
    expect(new SessionMetrics(() => 0).summarize(true)).not.toHaveProperty('feedbackPrompted');
  });

  it('survives a flush — prompts and submissions must be comparable over the session', () => {
    const m = new SessionMetrics(() => 0);
    m.recordFeedbackPrompt();
    m.reset();
    expect(m.summarize(true).feedbackPrompted).toBe(1);
  });
});

/**
 * An agent's error is often OUR defect — but only some of them, and we could not tell which.
 *
 * `toolErrors` was one number covering three different failures with three different fixes:
 *
 *   schema  — missing/unknown param, bad type   -> OUR schema is unclear
 *   state   — no session, stale ref              -> the world moved under the agent
 *   refusal — destructive block, unsupported     -> we said no on purpose
 *
 * The 2-day corpus is 60 state, 22 refusal, 20 schema (the zod dumps) and 20 stale-ref. Reading
 * that as "126 tool errors" hides that a sixth of them were our schema failing to explain itself.
 */
describe('tool errors are classified by whose defect they are', () => {
  const classify = (msg: string) => {
    const m = new SessionMetrics(() => 0);
    m.recordToolCall('reticle_act');
    m.recordToolError(msg, 'reticle_act');
    return m.summarize(true).errorClasses;
  };

  it('a rejected predicate is a SCHEMA failure — our grammar did not explain itself', () => {
    expect(
      classify('that predicate did not parse (kind "net"): unknown field urlContains'),
    ).toEqual({ schema: 1 });
  });

  it('a missing parameter is a SCHEMA failure', () => {
    expect(classify('Missing required parameter for reticle_session: action')).toEqual({
      schema: 1,
    });
  });

  it('no connected session is a STATE failure — the world moved, not our schema', () => {
    expect(classify('no browser session connected — but one WAS connected earlier')).toEqual({
      state: 1,
    });
  });

  it('a stale ref is a STATE failure', () => {
    expect(classify('ref e42 no longer resolves to an element')).toEqual({ state: 1 });
  });

  it('a destructive block is a REFUSAL — we said no on purpose and that is working', () => {
    expect(
      classify('potentially destructive action blocked; retry with args.confirmDangerous=true'),
    ).toEqual({ refusal: 1 });
  });

  it('anything unrecognised lands in `other`, so a blind spot is visible as one', () => {
    expect(classify('something nobody has seen before')).toEqual({ other: 1 });
  });

  it('is absent when nothing failed', () => {
    expect(new SessionMetrics(() => 0).summarize(true)).not.toHaveProperty('errorClasses');
  });
});

/**
 * The best measure of an error message is what the agent does NEXT.
 *
 * We had `consecutiveRepeats` (the loop) and `errors[]` (the shape) and never the join, so "we emit
 * good errors" was a belief. Recovered vs repeated turns it into a number — and it is the most
 * agent-specific metric available, because a human would just sigh and a log would show nothing.
 */
describe('recovery — did the agent get unstuck after an error', () => {
  it('counts a recovery when the next call succeeds', () => {
    const m = new SessionMetrics(() => 0);
    m.recordToolCall('reticle_act');
    m.recordToolError('ref e42 no longer resolves to an element', 'reticle_act');
    m.recordToolCall('reticle_query'); // looked it up again — the message worked
    const s = m.summarize(true);
    expect(s.errorsRecovered).toBe(1);
    expect(s).not.toHaveProperty('errorsRepeated');
  });

  it('counts a repeat when the very next call fails the same way', () => {
    const m = new SessionMetrics(() => 0);
    m.recordToolCall('reticle_act');
    m.recordToolError('ref e42 no longer resolves to an element', 'reticle_act');
    m.recordToolCall('reticle_act');
    m.recordToolError('ref e42 no longer resolves to an element', 'reticle_act');
    expect(m.summarize(true).errorsRepeated).toBe(1);
  });

  it('a clean session reports neither', () => {
    const m = new SessionMetrics(() => 0);
    m.recordToolCall('reticle_act');
    const s = m.summarize(true);
    expect(s).not.toHaveProperty('errorsRecovered');
    expect(s).not.toHaveProperty('errorsRepeated');
  });

  it('survives a flush — an error and its recovery can straddle a window boundary', () => {
    const m = new SessionMetrics(() => 0);
    m.recordToolCall('reticle_act');
    m.recordToolError('boom', 'reticle_act');
    m.reset();
    m.recordToolCall('reticle_query');
    expect(m.summarize(true).errorsRecovered).toBe(1);
  });
});
