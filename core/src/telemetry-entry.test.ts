/**
 * #2373 moved `BrowserBrand` out of `telemetry-feedback.ts` into the zod-free `browser-brand.ts`,
 * so the SDK can read it without zod. The `./telemetry` subpath re-exports `telemetry-feedback.ts`,
 * so it lost the name; only the root entry kept it. A diff of every entry point against the
 * published 3.10.2 package found it. A subpath keeps every name it published.
 */

import { describe, expect, it } from 'vitest';
import * as telemetry from './telemetry-entry.js';

describe('the ./telemetry subpath', () => {
  it('still exports BrowserBrand', () => {
    expect(telemetry.BrowserBrand).toBeDefined();
    expect(Object.values(telemetry.BrowserBrand)).toContain('chrome');
  });
});
