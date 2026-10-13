/**
 * Re-drive (persona 11): `init --app apps/web --port 17505` in a monorepo started a daemon and ran
 * `npm run dev` for the app, which failed there. Naming one app of a workspace asks for its files;
 * starting it is asked for with `--start`. A plain `init` in an app still boots it, as before.
 */
import { describe, expect, it } from 'vitest';
import { parseCliArgs } from './cli-parse.js';

const filesOnly = (argv: string[]): unknown => {
  const parsed = parseCliArgs(argv, 4400);
  return 'init' === parsed.kind ? parsed.filesOnly : parsed;
};

describe('init for one app of a workspace', () => {
  it('writes the files and starts nothing', () => {
    expect(filesOnly(['init', '--app', 'apps/web', '--port', '17505'])).toBe(true);
  });

  it('starts the app when asked', () => {
    expect(filesOnly(['init', '--app', 'apps/web', '--start'])).toBe(false);
  });

  it('is unchanged for a plain init', () => {
    expect(filesOnly(['init'])).toBe(false);
  });
});
