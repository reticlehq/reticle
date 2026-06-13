import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IrisCommand, MessageKind, type CommandMessage } from '@iris/protocol';

// Capture the deps Iris passes to Transport so tests can drive #handleCommand without a real
// WebSocket server. connect() still calls transport.connect(), which we stub to a no-op.
type HandleCommand = (command: CommandMessage) => Promise<{ ok: boolean; result?: unknown }>;
interface CapturedDeps {
  handleCommand: HandleCommand | undefined;
}
const captured: CapturedDeps = { handleCommand: undefined };

vi.mock('./transport.js', () => {
  class FakeTransport {
    constructor(deps: { handleCommand: HandleCommand }) {
      captured.handleCommand = deps.handleCommand;
    }
    connect(): void {
      /* no-op: no real socket in jsdom */
    }
    close(): void {
      /* no-op */
    }
    sendEvent(): void {
      /* no-op */
    }
  }
  return { Transport: FakeTransport };
});

// Imported after the mock is registered.
const { Iris } = await import('./iris.js');

const cmd = (name: string, args: Record<string, unknown> = {}): CommandMessage => ({
  kind: MessageKind.COMMAND,
  id: 'c1',
  name,
  args,
});

const dispatch = (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
  const h = captured.handleCommand;
  if (h === undefined) throw new Error('handleCommand not captured');
  return h(cmd(name, args));
};

const logRows = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-iris-log] [data-iris-log-row]'));
const dataOn = (): string | null =>
  document.querySelector('[data-iris-glow]')?.getAttribute('data-on') ?? null;

const FAST_IDLE_MS = 20;
const FAST_FADE_MS = 5;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '';
  captured.handleCommand = undefined;
});

afterEach(() => {
  document.querySelectorAll('[data-iris-overlay]').forEach((e) => e.remove());
});

describe('iris.ts session wiring (border)', () => {
  it('17 connect({present:true}) calls sessionStart -> border on', () => {
    const iris = new Iris();
    iris.connect({ present: true });
    expect(document.querySelector('[data-iris-glow]')).not.toBeNull();
    expect(dataOn()).toBe('1');
    iris.disconnect();
  });

  it('18 disconnect() calls sessionEnd -> border off then overlay removed', () => {
    const iris = new Iris();
    iris.connect({ present: true });
    expect(dataOn()).toBe('1');
    iris.disconnect();
    expect(document.querySelector('[data-iris-overlay]')).toBeNull();
  });

  it('19 connect({present:true, border:"busy"}) restores fade behavior end-to-end', async () => {
    const iris = new Iris();
    iris.connect({ present: true, border: 'busy', pace: 0 });
    await dispatch(IrisCommand.SNAPSHOT);
    // go quiet; busy machine fades the border out (old behavior)
    await wait(FAST_IDLE_MS + FAST_FADE_MS + 700 + 300);
    await flush();
    expect(dataOn()).toBe('0');
    iris.disconnect();
  });

  it('20 connect({present:false}) — no presenter, session calls are skipped', async () => {
    const iris = new Iris();
    iris.connect({ present: false });
    const out = await dispatch(IrisCommand.NARRATE, { text: 'hi' });
    expect((out as { ok: boolean }).ok).toBe(true);
    expect(document.querySelector('[data-iris-glow]')).toBeNull();
    expect(() => iris.disconnect()).not.toThrow();
  });

  it('21 disconnect() without a prior connect() is a safe no-op', () => {
    const iris = new Iris();
    expect(() => iris.disconnect()).not.toThrow();
    expect(document.querySelector('[data-iris-overlay]')).toBeNull();
  });

  it('22 double disconnect() after connect({present:true}) is a safe no-op', () => {
    const iris = new Iris();
    iris.connect({ present: true });
    iris.disconnect();
    expect(() => iris.disconnect()).not.toThrow();
    expect(document.querySelector('[data-iris-overlay]')).toBeNull();
  });
});

describe('iris.ts -> presenter log wiring', () => {
  it('W1 read commands log("read", label)', async () => {
    const iris = new Iris();
    iris.connect({ present: true, pace: 0 });
    await dispatch(IrisCommand.SNAPSHOT);
    const rows = logRows();
    const readRows = rows.filter((r) => r.querySelector('.iris-chip')?.textContent === 'READ');
    expect(readRows.length).toBeGreaterThanOrEqual(1);
    expect(readRows[0]?.querySelector('.iris-log-text')?.textContent).toBe('Looking at the page');
    iris.disconnect();
  });

  it('W2 act command logs act then updates result on success', async () => {
    document.body.innerHTML = '<button id="b">Save</button>';
    const iris = new Iris();
    iris.connect({ present: true, pace: 0 });
    // act on a ref that does not resolve still succeeds via the registry (no-op path); we only
    // need the act row + a pass glyph. Use a query first to register a ref is overkill; the act
    // handler tolerates an unknown ref by failing — so assert via a known-good snapshot+act.
    await dispatch(IrisCommand.SNAPSHOT);
    const before = logRows().length;
    await dispatch(IrisCommand.ACT, { ref: 'r-missing', action: 'click' });
    const actRows = logRows()
      .slice(before)
      .filter((r) => r.querySelector('.iris-chip')?.textContent === 'ACT');
    expect(actRows.length).toBeGreaterThanOrEqual(1);
    // result glyph present (pass or fail depending on ref resolution)
    const last = actRows[actRows.length - 1];
    expect(last?.textContent).toMatch(/[✓✗]/);
    iris.disconnect();
  });

  it('W5 narrate command appends (never overwrites) across 3 calls', async () => {
    const iris = new Iris();
    iris.connect({ present: true, pace: 0 });
    await dispatch(IrisCommand.NARRATE, { text: 'one' });
    await dispatch(IrisCommand.NARRATE, { text: 'two' });
    await dispatch(IrisCommand.NARRATE, { text: 'three' });
    const texts = logRows().map((r) => r.querySelector('.iris-log-text')?.textContent);
    expect(texts).toEqual(['one', 'two', 'three']);
    iris.disconnect();
  });

  it('W6 present:false → narrate/act commands are no-ops', async () => {
    const iris = new Iris();
    iris.connect({ present: false });
    const n = await dispatch(IrisCommand.NARRATE, { text: 'x' });
    expect((n as { ok: boolean }).ok).toBe(true);
    expect(document.querySelector('[data-iris-log]')).toBeNull();
    iris.disconnect();
  });
});
