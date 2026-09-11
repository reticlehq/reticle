import { describe, it, expect, beforeEach } from 'vitest';
import { TRANSPORT_LIMITS } from '@reticlehq/core';
import { RefRegistry, MAX_TRACKED_REFS, echoRef } from './refs.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('RefRegistry', () => {
  it('gives the same element the same ref', () => {
    const registry = new RefRegistry();
    const el = document.createElement('button');
    document.body.appendChild(el);
    expect(registry.refFor(el)).toBe(registry.refFor(el));
  });

  it('resolves a ref back to its element while it is connected', () => {
    const registry = new RefRegistry();
    const el = document.createElement('button');
    document.body.appendChild(el);
    expect(registry.resolve(registry.refFor(el))).toBe(el);
  });

  it('resolves to null once the element leaves the document', () => {
    const registry = new RefRegistry();
    const el = document.createElement('button');
    document.body.appendChild(el);
    const ref = registry.refFor(el);
    el.remove();
    expect(registry.resolve(ref)).toBeNull();
  });

  /**
   * Refs are minted far more often than an agent ever asks about them: every meaningful DOM addition,
   * every transitionend, every scroll reveal. The reverse map was a strong Map whose only eviction was
   * "the agent happened to resolve this exact dead ref", so on a long session over an app with CSS
   * transitions and list churn it grew without limit. The elements were collectable — the bookkeeping
   * about them was not.
   */
  /**
   * Generous per-test budget for the churn tests below.
   *
   * They build thousands of DOM nodes, and vitest's default 5 000 ms is a statement about the runner,
   * not about the code — observed timing out at 7 410 ms on a Windows CI box while the assertion it
   * was making held fine. CLAUDE.md prescribes exactly this remedy: a generous explicit timeout, never
   * a number that turns load into a red build.
   *
   * A bigger number cannot make a broken test pass — the bound is still asserted.
   */
  const HEAVY_DOM_TIMEOUT_MS = 60_000;

  describe('bounded memory', () => {
    it(
      'does not grow without limit as refs are minted',
      () => {
        const registry = new RefRegistry();
        for (let i = 0; i < MAX_TRACKED_REFS * 2; i += 1) {
          // Deliberately NOT appended and not retained: these are the transient elements a busy app
          // mints refs for and then discards.
          registry.refFor(document.createElement('div'));
        }
        expect(registry.size).toBeLessThanOrEqual(MAX_TRACKED_REFS);
      },
      HEAVY_DOM_TIMEOUT_MS,
    );

    it(
      'keeps resolving an element that is still on the page after heavy churn',
      () => {
        const registry = new RefRegistry();
        const kept = document.createElement('button');
        document.body.appendChild(kept);
        const ref = registry.refFor(kept);

        for (let i = 0; i < MAX_TRACKED_REFS * 2; i += 1) {
          registry.refFor(document.createElement('div'));
        }

        // The live element is re-observed the way any snapshot/query would re-observe it. Eviction must
        // not turn a still-present element into "not found" — a wrong answer is worse than a big Map.
        expect(registry.refFor(kept)).toBe(ref);
        expect(registry.resolve(ref)).toBe(kept);
      },
      HEAVY_DOM_TIMEOUT_MS,
    );

    it(
      'a ref the agent just RESOLVED survives a following mint storm (LRU-protected)',
      () => {
        // The false negative: resolve e7 (about to act on it), a mint storm evicts e7 (FIFO oldest-drop),
        // then act(e7) -> resolve returns null for a LIVE element. Resolving must touch it to the recent
        // end so the next wave of oldest-drops can't reclaim it out from under the agent.
        const registry = new RefRegistry();
        const kept = document.createElement('button');
        document.body.appendChild(kept);
        const ref = registry.refFor(kept);
        // Churn CONNECTED elements (so the dead-entry sweep can't be what saves `kept` — isolate LRU).
        const fill = (n: number): void => {
          for (let i = 0; i < n; i += 1) {
            const d = document.createElement('div');
            document.body.appendChild(d);
            registry.refFor(d);
          }
        };
        fill(MAX_TRACKED_REFS - 1); // `kept` is now the oldest entry, at the eviction front
        expect(registry.resolve(ref)).toBe(kept); // agent resolves it — LRU touch to the recent end
        fill(MAX_TRACKED_REFS - 1); // a second storm evicts the OLD front, but not the just-touched `kept`
        // Still resolves WITHOUT re-observing via refFor — protected purely by the resolve-time touch.
        expect(registry.resolve(ref)).toBe(kept);
        // Heaviest of the three: this one APPENDS ~20k elements to the document rather than just
        // minting refs for detached ones, so it is the most exposed to a loaded runner.
      },
      HEAVY_DOM_TIMEOUT_MS,
    );
  });
});

/**
 * A caller-supplied ref is untrusted input, and every stale-ref message interpolates it.
 *
 * Found by fuzzing the tool surface: `reticle_inspect { ref: 'x'.repeat(100_000) }` produced an
 * error carrying the whole argument. The server caps error messages centrally, but not in time for
 * this one — the transport serializer truncates from the tail on the way out of the page, which
 * removes "no longer resolves to an element" and with it the server's ability to recognize a stale
 * ref at all. The agent was then told its own typo may be a defect in Reticle.
 */
describe('echoRef — a ref is bounded before it goes into a message', () => {
  it('leaves a real ref exactly as it is', () => {
    expect(echoRef('e7')).toBe('e7');
  });

  it('bounds a caller-supplied ref that is absurdly long', () => {
    const echoed = echoRef('x'.repeat(100_000));
    expect(echoed.length).toBeLessThanOrEqual(TRANSPORT_LIMITS.MAX_REF_LENGTH + 1);
  });

  it('keeps the message classifiable, which is the whole point', () => {
    const message = `ref '${echoRef('x'.repeat(100_000))}' no longer resolves to an element`;
    // Short enough that no downstream truncation can reach the suffix the recovery table matches.
    expect(message.length).toBeLessThan(TRANSPORT_LIMITS.MAX_ERROR_LENGTH);
    expect(message).toMatch(/no longer resolves to an element$/);
  });
});
