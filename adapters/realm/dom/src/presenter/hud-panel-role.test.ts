/**
 * Reticle's HUD panels must not claim `role="dialog"`.
 *
 * Radix/shadcn outside-click handlers treat a foreign dialog layer as grounds to dismiss the app's
 * own modal. The HUD is not that layer — but advertising `role="dialog"` made it one in the
 * accessibility tree, which reproduced as a Select inside an app Dialog closing on synthetic click
 * (#783).
 *
 * `role="region"` with an `aria-label` still names the panel for screen readers without masquerading
 * as the application's modal.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const read = (name: string): string => readFileSync(join(dir, name), 'utf8');

const HUD_PANEL_SOURCES = [
  'presenter-shell.ts',
  'presenter-report.ts',
  'presenter-settings.ts',
  'presenter-workspace.ts',
] as const;

describe('HUD panels are regions, not app dialogs', () => {
  for (const file of HUD_PANEL_SOURCES) {
    it(`${file} does not advertise role="dialog" on a HUD panel`, () => {
      const src = read(file);
      expect(src).not.toMatch(/role="dialog"/);
      expect(src).toContain('role="region"');
    });
  }
});
