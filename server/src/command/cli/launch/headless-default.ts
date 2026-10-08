/**
 * Whether a browser Reticle opens is shown or hidden when no flag says.
 *
 * Its own module because `cli-parse.ts` is pure and takes the answer as an argument; `cli.ts` asks
 * this with the real environment and hands the result over.
 */

/** Set to anything to hide every browser Reticle opens. The test batteries set it. */
export const HEADLESS_ENV = 'RETICLE_HEADLESS';

/**
 * Whether a browser Reticle opens is hidden when no flag says. Shown by default, for every command:
 * the pool behind `serve`/`mcp` used to be hidden on the theory that nobody watches batch work, and
 * from the field that was a person watching an agent drive their app and seeing nothing happen.
 * Hidden where showing is impossible or unwanted: CI, the test batteries, and a Linux machine with
 * no display server, where a headed launch fails instead of showing anything.
 */
export function headlessByDefault(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): boolean {
  if (env['CI'] !== undefined || env[HEADLESS_ENV] !== undefined) return true;
  return (
    'linux' === platform && env['DISPLAY'] === undefined && env['WAYLAND_DISPLAY'] === undefined
  );
}
