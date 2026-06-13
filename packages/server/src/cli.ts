#!/usr/bin/env node
import { IRIS_DEFAULT_PORT } from '@iris/protocol';
import { start } from './index.js';
import { log } from './log.js';

const portEnv = process.env['IRIS_PORT'];
const port = portEnv === undefined ? IRIS_DEFAULT_PORT : Number.parseInt(portEnv, 10);

start({ port })
  .then(() => {
    log('iris_started', { port });
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log('iris_start_failed', { error: message });
    process.exit(1);
  });
