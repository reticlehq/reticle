import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { ReticleDir, ReticleEnv, resolveStateDir } from '@reticlehq/core';
import { log } from '@/log.js';

/**
 * Auto-provisioned bridge pairing token. The daemon reads-or-creates a per-user secret at
 * ~/.reticle/pairing-token; the bridge then requires it, so a rogue localhost app (which, running in a
 * browser sandbox, cannot read the file) can no longer register/drive sessions just by being on a
 * loopback origin. The build plugins read the same file Node-side and inject it into connect, so a
 * legitimately-served app stays zero-config.
 */

/** Injectable IO + randomness so the provisioner is unit-testable without touching the real home dir. */
export interface PairingTokenDeps {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  randomToken: () => string;
}

/** 24 random bytes → 48 hex chars: well under MAX_TOKEN_LENGTH, ample entropy for a local secret. */
const TOKEN_BYTES = 24;

/** Env override for the token directory (`RETICLE_PAIRING_TOKEN_DIR`) — relocate the secret off $HOME. */
export const PAIRING_TOKEN_DIR_ENV = ReticleEnv.PAIRING_TOKEN_DIR;

/** The warnings already written, so that each one is written once for each process. */
const warnedOnce = new Set<string>();

function warnOnce(warning: string): void {
  if (warnedOnce.has(warning)) {
    return;
  }
  warnedOnce.add(warning);
  log('state_dir_warning', { warning });
}

/** The token folder for `override`, by the shared rule. A setting that cannot be used warns and never throws. */
function tokenDir(override: string | undefined): string {
  return resolveStateDir(
    override,
    join(homedir(), ReticleDir.ROOT),
    { isAbsolute, resolve, sep },
    warnOnce,
  );
}

/** The default directory that holds the token — the per-user ~/.reticle so it's shared across projects. */
export function defaultPairingTokenDir(): string {
  return tokenDir(process.env[PAIRING_TOKEN_DIR_ENV]);
}

/**
 * Which of the three sources supplied the token this process is using.
 *
 * The SOURCE, never the secret. #685 reports a globally-registered daemon refusing an app that
 * `doctor` calls correctly wired, and blames the daemon's cwd — but cwd cannot reach this value:
 * resolution is options.token, then RETICLE_TOKEN, then the file under ~/.reticle, and the Vite
 * plugin reads that same file. What CAN diverge is the ENVIRONMENT, because an IDE spawning a global
 * MCP server does not inherit the shell that started the dev server. Either variable then moves one
 * side and not the other, and neither is visible in anything we print — so the refusal is a mystery
 * with no witness, which is how this report has stayed open on a guessed cause.
 *
 * Pure, and takes its env, so the order can be pinned by tests rather than by reading two files.
 */
export function pairingTokenSource(input: {
  explicit: boolean;
  env: NodeJS.ProcessEnv;
}): 'explicit' | 'env:RETICLE_TOKEN' | 'env:RETICLE_PAIRING_TOKEN_DIR' | 'default' {
  // Same precedence the resolver applies, deliberately: a source that did not decide the value is a
  // misdirection, and this exists to stop one.
  if (input.explicit) return 'explicit';
  const token = input.env[ReticleEnv.TOKEN];
  if (token !== undefined && 0 < token.length) return `env:${ReticleEnv.TOKEN}`;
  const dir = input.env[PAIRING_TOKEN_DIR_ENV];
  if (dir !== undefined && 0 < dir.length) return `env:${PAIRING_TOKEN_DIR_ENV}`;
  return 'default';
}

/**
 * The pairing token this machine was told to use, or undefined when it was told nothing.
 *
 * `RETICLE_TOKEN` first, then the token file in `RETICLE_PAIRING_TOKEN_DIR`, the precedence
 * `pairingTokenSource` names. A command that mints its own one-shot token for a hosted preview asks
 * this first: in a container the app's plugin bakes the directory token in, and a fresh token made
 * the daemon refuse the only app it was started to verify (#1251).
 */
export async function configuredPairingToken(
  env: NodeJS.ProcessEnv,
  deps: PairingTokenDeps,
): Promise<string | undefined> {
  const token = env[ReticleEnv.TOKEN]?.trim();
  if (token !== undefined && 0 < token.length) return token;
  const dir = env[PAIRING_TOKEN_DIR_ENV];
  if (dir === undefined || 0 === dir.length) return undefined;
  return readOrCreatePairingToken(dir, deps);
}

/**
 * The token a local command shows the daemon: `RETICLE_TOKEN`, else the stored file. Never creates
 * one, because a new token is not the token the running daemon holds.
 */
export function storedPairingToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env[ReticleEnv.TOKEN]?.trim();
  if (fromEnv !== undefined && 0 < fromEnv.length) {
    return fromEnv;
  }
  try {
    const stored = readFileSync(pairingTokenPath(defaultPairingTokenDir()), 'utf8').trim();
    return 0 < stored.length ? stored : undefined;
  } catch {
    return undefined;
  }
}

/** The token file in `dir`, with `dir` resolved by the same rule as `RETICLE_PAIRING_TOKEN_DIR`. */
export function pairingTokenPath(dir: string): string {
  return join(tokenDir(dir), ReticleDir.PAIRING_TOKEN_FILE);
}

/** Production IO adapter: 0600 file + 0700 dir so only the owner can read the secret. */
export function nodePairingTokenDeps(): PairingTokenDeps {
  return {
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: async (path, data) => {
      await writeFile(path, data, { encoding: 'utf8', mode: 0o600 });
      // Enforce perms even if the file pre-existed with a looser mode (writeFile keeps old perms).
      await chmod(path, 0o600);
    },
    mkdir: async (path) => {
      await mkdir(path, { recursive: true, mode: 0o700 });
    },
    randomToken: () => randomBytes(TOKEN_BYTES).toString('hex'),
  };
}

/**
 * Read the stored token, or create + persist one on first run. Stable across restarts so a
 * plugin-injected page keeps working after the daemon bounces. Best-effort: returns undefined if IO
 * fails, so the caller degrades to the prior tokenless behavior rather than bricking the daemon.
 */
export async function readOrCreatePairingToken(
  dir: string,
  deps: PairingTokenDeps,
): Promise<string | undefined> {
  const folder = tokenDir(dir);
  const file = join(folder, ReticleDir.PAIRING_TOKEN_FILE);
  try {
    const existing = (await deps.readFile(file)).trim();
    if (existing.length > 0) return existing;
  } catch {
    // Missing/unreadable — fall through to create one.
  }
  try {
    const token = deps.randomToken().trim();
    if (0 === token.length) return undefined;
    await deps.mkdir(folder);
    await deps.writeFile(file, token);
    return token;
  } catch {
    return undefined;
  }
}

/**
 * Sync twin of `readOrCreatePairingToken`. `reticle init` and Next's `withReticle` are both
 * synchronous, and a snippet printed with no token is a page that can never authenticate.
 */
export function readOrCreatePairingTokenSync(dir: string): string | undefined {
  const folder = tokenDir(dir);
  const file = join(folder, ReticleDir.PAIRING_TOKEN_FILE);
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length > 0) return existing;
  } catch {
    /* missing or unreadable — fall through and create one */
  }
  try {
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    if (0 === token.length) return undefined;
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
    chmodSync(file, 0o600);
    return token;
  } catch {
    return undefined;
  }
}
