#!/usr/bin/env node
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
const require = createRequire(import.meta.url);
const serverEntry = require.resolve('@syrin/iris-server'); // .../@syrin/iris-server/dist/index.js
const cli = path.join(path.dirname(serverEntry), 'cli.js');
spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit' }).on('exit', (c) =>
  process.exit(c ?? 0),
);
