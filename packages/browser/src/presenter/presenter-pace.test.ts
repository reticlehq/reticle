/**
 * The HUD's pacing is charged to the AGENT, and until it was measured nobody knew how much.
 *
 * `beforeAct` awaits `pace(450)` twice-over the life of a click so a human can watch the cursor glide
 * to the element before it fires. That is the product working as intended in a browser somebody is
 * looking at. In a headless one it is 450ms of nothing, on every single action.
 *
 * Measured with RETICLE_TRACE over the e2e battery: 42 `act` round-trips, 40 of them between 452ms
 * and 460ms - a fixed cost, not app work - totalling 19.7 SECONDS, which was 98.5% of all the time
 * the battery spent in the browser. Every other command (query, scroll, match, snapshot) was 1–4ms.
 * An agent loop of 50–200 actions pays 22–90 seconds to animate a cursor nobody can see.
 *
 * `navigator.webdriver` is the discriminator, and it is exactly the right one: it is true in a
 * browser under automation (Playwright, CDP, the pool's leased tabs, this battery) and false in the
 * dev browser a human has open - which is the case the HUD exists for and keeps its pacing.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { effectivePaceMs } from './presenter-config.js';
import { DEFAULT_PACE } from './presenter-config.js';

const HUMAN = { webdriver: false } as Navigator;
const AUTOMATED = { webdriver: true } as Navigator;

describe('effectivePaceMs', () => {
  afterEach(() => {
    // nothing global to restore - the navigator is injected
  });

  it('paces a browser a human is watching - the HUD is the product there', () => {
    expect(effectivePaceMs(undefined, HUMAN)).toBe(DEFAULT_PACE);
  });

  it('does not pace an automated browser: nobody is watching and the agent pays the wait', () => {
    expect(effectivePaceMs(undefined, AUTOMATED)).toBe(0);
  });

  /**
   * An EXPLICIT paceMs is a decision somebody made - a recorded demo runs under automation and still
   * wants the cursor to glide. Overriding it here would make the option a lie.
   */
  it('never overrides a pace the caller asked for, in either browser', () => {
    expect(effectivePaceMs(120, AUTOMATED)).toBe(120);
    expect(effectivePaceMs(0, HUMAN)).toBe(0);
  });

  it('paces when there is no navigator to ask, rather than silently dropping the HUD behaviour', () => {
    expect(effectivePaceMs(undefined, undefined)).toBe(DEFAULT_PACE);
  });
});
