#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { IRIS_DEFAULT_PORT } from '@syrin/iris-protocol';
import { start } from './index.js';
import { log } from './log.js';

/** Local CLI usage string (never crosses the wire) — named, not a free string. */
export const DRIVE_USAGE = 'usage: iris drive <url> [--headed]';

/** `--headed` flips the default headless launch off. */
const HEADED_FLAG = '--headed';
const DRIVE_COMMAND = 'drive';

export type DriveCliResult =
  | { kind: 'serve'; port: number }
  | { kind: 'drive'; driveUrl: string; headless: boolean; port: number }
  | { kind: 'error'; message: string };

/** Pure, exported for unit tests. argv = process.argv.slice(2). */
export function parseDriveArgs(argv: string[], port: number): DriveCliResult {
  if (argv.length === 0 || argv[0] !== DRIVE_COMMAND) {
    return { kind: 'serve', port };
  }
  const rest = argv.slice(1);
  let headless = true;
  let driveUrl: string | undefined;
  for (const arg of rest) {
    if (arg === HEADED_FLAG) {
      headless = false;
    } else if (arg.startsWith('--')) {
      return { kind: 'error', message: DRIVE_USAGE };
    } else if (driveUrl === undefined) {
      driveUrl = arg;
    } else {
      return { kind: 'error', message: DRIVE_USAGE };
    }
  }
  if (driveUrl === undefined) return { kind: 'error', message: DRIVE_USAGE };
  return { kind: 'drive', driveUrl, headless, port };
}

function main(): void {
  const portEnv = process.env['IRIS_PORT'];
  const port = portEnv === undefined ? IRIS_DEFAULT_PORT : Number.parseInt(portEnv, 10);
  const parsed = parseDriveArgs(process.argv.slice(2), port);

  if (parsed.kind === 'error') {
    log('iris_usage_error', { message: parsed.message });
    process.exit(1);
  }

  const options =
    parsed.kind === 'drive'
      ? { port: parsed.port, driveUrl: parsed.driveUrl, headless: parsed.headless }
      : { port: parsed.port };

  start(options)
    .then(() => {
      log('iris_started', { port: parsed.port });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log('iris_start_failed', { error: message });
      process.exit(1);
    });
}

/** Run only when invoked as the CLI entrypoint, not when imported by tests. */
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main();
}
