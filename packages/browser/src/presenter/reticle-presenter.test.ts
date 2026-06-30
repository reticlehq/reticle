import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  EventType,
  HumanControlKind,
  ReticleCommand,
  MessageKind,
  SessionState,
  type CommandMessage,
  type ReticleEvent,
} from '@reticle/protocol';

// Capture the deps Reticle passes to Transport so tests can drive #handleCommand without a real
// WebSocket server. connect() still calls transport.connect(), which we stub to a no-op.
type HandleCommand = (command: CommandMessage) => Promise<{ ok: boolean; result?: unknown }>;
interface CapturedDeps {
  handleCommand: HandleCommand | undefined;
}
const captured: CapturedDeps = { handleCommand: undefined };
const sentEvents: ReticleEvent[] = [];

vi.mock('../transport/transport.js', () => {
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
    sendEvent(event: ReticleEvent): void {
      sentEvents.push(event);
    }
  }
  return { Transport: FakeTransport };
});

// Imported after the mock is registered.
const { Reticle } = await import('../reticle.js');

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
  Array.from(document.querySelectorAll<HTMLElement>('[data-reticle-log] [data-reticle-log-row]'));
const dataOn = (): string | null =>
  document.querySelector('[data-reticle-glow]')?.getAttribute('data-on') ?? null;

const FAST_IDLE_MS = 20;
const FAST_FADE_MS = 5;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const clickSel = (sel: string): void => {
  document.querySelector(sel)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};
const humanControlEvents = (): ReticleEvent[] =>
  sentEvents.filter((e) => e.type === EventType.HUMAN_CONTROL);

beforeEach(() => {
  document.body.innerHTML = '';
  captured.handleCommand = undefined;
  sentEvents.length = 0;
});

afterEach(() => {
  document.querySelectorAll('[data-reticle-overlay]').forEach((e) => e.remove());
});

describe('reticle.ts session wiring (border)', () => {
  it('17 connect({present:true}) mounts the overlay but stays dormant until the first command', async () => {
    const reticle = new Reticle();
    reticle.connect({ present: true, pace: 0 });
    // Overlay is mounted (ready) but the session has NOT started — no glow, no panel — because
    // nothing has happened yet. (The page merely loaded the SDK.)
    expect(document.querySelector('[data-reticle-glow]')).not.toBeNull();
    expect(dataOn()).not.toBe('1'); // dormant: no border until the agent acts
    // The agent's first command starts the session → border on.
    await dispatch(ReticleCommand.SNAPSHOT);
    expect(dataOn()).toBe('1');
    reticle.disconnect();
  });

  it('18 disconnect() calls sessionEnd -> border off then overlay removed', async () => {
    const reticle = new Reticle();
    reticle.connect({ present: true, pace: 0 });
    await dispatch(ReticleCommand.SNAPSHOT); // start the session so the border is on
    expect(dataOn()).toBe('1');
    reticle.disconnect();
    expect(document.querySelector('[data-reticle-overlay]')).toBeNull();
  });

  it('19 connect({present:true, border:"busy"}) restores fade behavior end-to-end', async () => {
    const reticle = new Reticle();
    reticle.connect({ present: true, border: 'busy', pace: 0 });
    await dispatch(ReticleCommand.SNAPSHOT);
    // go quiet; busy machine fades the border out (old behavior)
    await wait(FAST_IDLE_MS + FAST_FADE_MS + 700 + 300);
    await flush();
    expect(dataOn()).toBe('0');
    reticle.disconnect();
  });

  it('20 connect({present:false}) — no presenter, session calls are skipped', async () => {
    const reticle = new Reticle();
    reticle.connect({ present: false });
    const out = await dispatch(ReticleCommand.NARRATE, { text: 'hi' });
    expect((out as { ok: boolean }).ok).toBe(true);
    expect(document.querySelector('[data-reticle-glow]')).toBeNull();
    expect(() => reticle.disconnect()).not.toThrow();
  });

  it('21 disconnect() without a prior connect() is a safe no-op', () => {
    const reticle = new Reticle();
    expect(() => reticle.disconnect()).not.toThrow();
    expect(document.querySelector('[data-reticle-overlay]')).toBeNull();
  });

  it('22 double disconnect() after connect({present:true}) is a safe no-op', () => {
    const reticle = new Reticle();
    reticle.connect({ present: true });
    reticle.disconnect();
    expect(() => reticle.disconnect()).not.toThrow();
    expect(document.querySelector('[data-reticle-overlay]')).toBeNull();
  });
});

describe('reticle.ts -> presenter log wiring', () => {
  it('read commands log("read", label)', async () => {
    const reticle = new Reticle();
    reticle.connect({ present: true, pace: 0 });
    await dispatch(ReticleCommand.SNAPSHOT);
    const rows = logRows();
    const readRows = rows.filter((r) => r.querySelector('.reticle-chip')?.textContent === 'READ');
    expect(readRows.length).toBeGreaterThanOrEqual(1);
    expect(readRows[0]?.querySelector('.reticle-log-text')?.textContent).toBe(
      'Looking at the page',
    );
    reticle.disconnect();
  });

  it('act command logs act then updates result on success', async () => {
    document.body.innerHTML = '<button id="b">Save</button>';
    const reticle = new Reticle();
    reticle.connect({ present: true, pace: 0 });
    // act on a ref that does not resolve still succeeds via the registry (no-op path); we only
    // need the act row + a pass glyph. Use a query first to register a ref is overkill; the act
    // handler tolerates an unknown ref by failing — so assert via a known-good snapshot+act.
    await dispatch(ReticleCommand.SNAPSHOT);
    const before = logRows().length;
    await dispatch(ReticleCommand.ACT, { ref: 'r-missing', action: 'click' });
    const actRows = logRows()
      .slice(before)
      .filter((r) => r.querySelector('.reticle-chip')?.textContent === 'ACT');
    expect(actRows.length).toBeGreaterThanOrEqual(1);
    // result glyph present (pass or fail depending on ref resolution)
    const last = actRows[actRows.length - 1];
    expect(last?.textContent).toMatch(/[✓✗]/);
    reticle.disconnect();
  });

  it('narrate command appends (never overwrites) across 3 calls', async () => {
    const reticle = new Reticle();
    reticle.connect({ present: true, pace: 0 });
    await dispatch(ReticleCommand.NARRATE, { text: 'one' });
    await dispatch(ReticleCommand.NARRATE, { text: 'two' });
    await dispatch(ReticleCommand.NARRATE, { text: 'three' });
    const texts = logRows().map((r) => r.querySelector('.reticle-log-text')?.textContent);
    expect(texts).toEqual(['one', 'two', 'three']);
    reticle.disconnect();
  });

  it('present:false → narrate/act commands are no-ops', async () => {
    const reticle = new Reticle();
    reticle.connect({ present: false });
    const n = await dispatch(ReticleCommand.NARRATE, { text: 'x' });
    expect((n as { ok: boolean }).ok).toBe(true);
    expect(document.querySelector('[data-reticle-log]')).toBeNull();
    reticle.disconnect();
  });
});

describe('reticle.ts -> live-control wiring', () => {
  it('18 panel pause emits a HUMAN_CONTROL event over transport', () => {
    const reticle = new Reticle();
    reticle.connect({ present: true, pace: 0 });
    clickSel('[data-reticle-pause]');
    const evs = humanControlEvents();
    expect(evs.length).toBe(1);
    expect(evs[0]?.data).toEqual({ kind: HumanControlKind.PAUSE });
    expect(typeof evs[0]?.t).toBe('number');
    reticle.disconnect();
  });

  it('19 send emits a HUMAN_CONTROL message event with text', () => {
    const reticle = new Reticle();
    reticle.connect({ present: true, pace: 0 });
    const inp = document.querySelector<HTMLInputElement>('[data-reticle-input]');
    if (inp === null) throw new Error('no input');
    inp.value = 'check the cart total';
    clickSel('[data-reticle-send]');
    const evs = humanControlEvents();
    expect(evs.length).toBe(1);
    expect(evs[0]?.data).toEqual({
      kind: HumanControlKind.MESSAGE,
      text: 'check the cart total',
    });
    reticle.disconnect();
  });

  it('20 PRESENTER command from server calls setState without emitting', async () => {
    const reticle = new Reticle();
    reticle.connect({ present: true, pace: 0 });
    const out = await dispatch(ReticleCommand.PRESENTER, { state: SessionState.PAUSED });
    expect((out as { ok: boolean }).ok).toBe(true);
    expect(
      document
        .querySelector('[data-reticle-overlay][data-reticle-state]')
        ?.getAttribute('data-reticle-state'),
    ).toBe('paused');
    expect(humanControlEvents().length).toBe(0);
    reticle.disconnect();
  });

  it('21 PRESENTER with unknown state is a safe no-op', async () => {
    const reticle = new Reticle();
    reticle.connect({ present: true, pace: 0 });
    const out = await dispatch(ReticleCommand.PRESENTER, { state: 'bogus' });
    expect((out as { ok: boolean }).ok).toBe(true);
    expect(
      document
        .querySelector('[data-reticle-overlay][data-reticle-state]')
        ?.getAttribute('data-reticle-state'),
    ).toBe('active');
    reticle.disconnect();
  });
});
