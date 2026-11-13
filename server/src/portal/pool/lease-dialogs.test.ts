/**
 * A leased page answers a native `confirm()` with yes only for a press that said yes (#2167).
 *
 * The pool dismisses every native dialog on a lease, so that the page cannot wedge (#786). A real
 * key press (Enter on a form whose submit handler asks `confirm()`) opens a native dialog that the
 * SDK never sees. Before this change the pool dismissed it even when the action carried
 * `confirmDangerous: true`, so a destructive flow behind a confirm could not be driven on a lease.
 */
import { describe, expect, it } from 'vitest';
import { BrowserPool } from './browser-pool.js';
import type { Launcher, PooledDialog, PooledPage } from './browser-pool.js';
import type { RealInputResult } from '@/portal/input/real-input.js';

type DialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload';

/** A leased page whose key press opens the dialogs it is given, and records how each was answered. */
class DialogPage {
  readonly answers: string[] = [];
  /** The dialogs the next press opens. */
  opens: DialogType[] = [];
  /** Hold the press open until this resolves, so a second press can overlap it. */
  hold: Promise<void> = Promise.resolve();
  canAccept = true;
  #onDialog: ((dialog: PooledDialog) => void) | undefined;

  page(): PooledPage {
    return {
      goto: () => Promise.resolve(undefined),
      close: () => Promise.resolve(),
      onCrash: () => undefined,
      onDialog: (handler) => {
        this.#onDialog = handler;
      },
      press: async (): Promise<RealInputResult> => {
        const opens = this.opens;
        this.opens = [];
        await this.hold;
        for (const type of opens) {
          this.open(type);
        }
        return { performed: true, inputMode: 'real' };
      },
    };
  }

  /** Open one native dialog, as the page does from a handler. */
  open(type: DialogType): void {
    const answer = (how: string) => (): Promise<void> => {
      this.answers.push(`${type}:${how}`);
      return Promise.resolve();
    };
    this.#onDialog?.({
      message: `${type}?`,
      kind: type,
      dismiss: answer('dismissed'),
      ...(this.canAccept ? { accept: answer('accepted') } : {}),
    });
  }
}

let seq = 0;
async function leased(fake: DialogPage): Promise<{ pool: BrowserPool; id: string }> {
  const launch: Launcher = () =>
    Promise.resolve({
      newContext: () =>
        Promise.resolve({
          newPage: () => Promise.resolve(fake.page()),
          close: () => Promise.resolve(),
        }),
      close: () => Promise.resolve(),
      onDisconnected: (): void => undefined,
      isConnected: (): boolean => true,
    });
  const pool = new BrowserPool(launch, {
    maxContexts: 2,
    genSessionId: () => `lease-${String((seq += 1))}`,
  });
  const lease = await pool.acquire('http://app.test/');
  return { pool, id: lease.sessionId };
}

const ENTER = { text: 'Enter' };

describe('a native confirm() on a lease', () => {
  it('is accepted when the press carries confirmDangerous', async () => {
    const fake = new DialogPage();
    const { pool, id } = await leased(fake);
    fake.opens = ['confirm'];
    await pool.pressLease(id, ENTER, true);
    expect(fake.answers).toEqual(['confirm:accepted']);
    expect(pool.lastDialogMessage(id)).toBe('confirm?');
    await pool.shutdown();
  });

  it('is still dismissed without it', async () => {
    const fake = new DialogPage();
    const { pool, id } = await leased(fake);
    fake.opens = ['confirm'];
    await pool.pressLease(id, ENTER);
    fake.opens = ['confirm'];
    await pool.pressLease(id, ENTER, false);
    expect(fake.answers).toEqual(['confirm:dismissed', 'confirm:dismissed']);
    await pool.shutdown();
  });

  it('spends the yes on one confirm, and never on alert, prompt or beforeunload', async () => {
    const fake = new DialogPage();
    const { pool, id } = await leased(fake);
    fake.opens = ['alert', 'prompt', 'beforeunload', 'confirm', 'confirm'];
    await pool.pressLease(id, ENTER, true);
    expect(fake.answers).toEqual([
      'alert:dismissed',
      'prompt:dismissed',
      'beforeunload:dismissed',
      'confirm:accepted',
      'confirm:dismissed',
    ]);
    await pool.shutdown();
  });

  it('does not carry the yes past its press', async () => {
    const fake = new DialogPage();
    const { pool, id } = await leased(fake);
    fake.opens = ['confirm'];
    await pool.pressLease(id, ENTER, true);
    // A confirm the page opens later, from a timer, belongs to no press.
    fake.open('confirm');
    fake.opens = ['confirm'];
    await pool.pressLease(id, ENTER);
    expect(fake.answers).toEqual(['confirm:accepted', 'confirm:dismissed', 'confirm:dismissed']);
    await pool.shutdown();
  });

  it('is dismissed while a press without the yes is in flight beside it', async () => {
    const fake = new DialogPage();
    const { pool, id } = await leased(fake);
    let release: () => void = () => undefined;
    fake.hold = new Promise((resolve) => {
      release = resolve;
    });
    fake.opens = ['confirm'];
    const plain = pool.pressLease(id, ENTER);
    fake.opens = ['confirm'];
    const flagged = pool.pressLease(id, ENTER, true);
    release();
    await Promise.all([plain, flagged]);
    expect(fake.answers).toEqual(['confirm:dismissed', 'confirm:dismissed']);
    await pool.shutdown();
  });

  it('is dismissed when the page cannot accept a dialog', async () => {
    const fake = new DialogPage();
    fake.canAccept = false;
    const { pool, id } = await leased(fake);
    fake.opens = ['confirm'];
    await pool.pressLease(id, ENTER, true);
    expect(fake.answers).toEqual(['confirm:dismissed']);
    await pool.shutdown();
  });
});
