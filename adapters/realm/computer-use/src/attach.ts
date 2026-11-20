/**
 * What `reticle-computer-use` needs to join a bridge: which application, which bridge, the token
 * of that bridge, and the folders to watch. Pure, so a test gives it arguments and files.
 */
import { join } from 'node:path';

import { RETICLE_DEFAULT_PORT, bridgeWsUrl } from '@reticlehq/core';

const Flag = { APP: '--app', PORT: '--port', WATCH: '--watch' } as const;
const Env = {
  TOKEN: 'RETICLE_TOKEN',
  PORT: 'RETICLE_PORT',
  TOKEN_DIR: 'RETICLE_PAIRING_TOKEN_DIR',
} as const;
const STATE_DIR = '.reticle';
const TOKEN_FILE = 'pairing-token';

export interface AttachPlan {
  app: string;
  url: string;
  /** Absent when the bridge has no token file. A bridge with a token then refuses the dial. */
  token?: string;
  watch: string[];
}

export function attachPlan(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  readFile: (path: string) => string | undefined,
): AttachPlan | { error: string } {
  const valuesOf = (flag: string): string[] =>
    argv.flatMap((arg, index) => (arg === flag ? [argv[index + 1] ?? ''] : []));
  const app = valuesOf(Flag.APP)[0];
  if (app === undefined || 0 === app.length) {
    return { error: `Name the application: ${Flag.APP} <name>.` };
  }
  const port = Number(valuesOf(Flag.PORT)[0] ?? env[Env.PORT] ?? RETICLE_DEFAULT_PORT);
  const token =
    env[Env.TOKEN] ??
    readFile(join(env[Env.TOKEN_DIR] ?? join(home, STATE_DIR), TOKEN_FILE))?.trim();
  return {
    app,
    url: bridgeWsUrl(port),
    ...(token === undefined || 0 === token.length ? {} : { token }),
    watch: valuesOf(Flag.WATCH),
  };
}
