import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MacDriver } from './mac-driver.js';

/**
 * The driver keeps one helper process and sends it one command for each line. This holds what
 * happens at the edges of that: answers come back in order, and a helper that ends does not leave
 * a command with no answer.
 *
 * The helper here is a script that speaks the same lines. It needs a `#!` line, so the test is for
 * a POSIX system; the realm itself is for macOS only.
 */
const posix = 'win32' !== process.platform;

function helperThat(body: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'reticle-cu-helper-')), 'helper.mjs');
  writeFileSync(
    file,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';
let count = 0;
const tree = (name) => JSON.stringify({ tree: { role: 'AXWindow', title: name, children: [] }, unread: 0 });
for await (const line of createInterface({ input: process.stdin })) {
  count += 1;
  ${body}
}
`,
  );
  chmodSync(file, 0o755);
  return file;
}

describe.skipIf(!posix)('one helper process for many commands', () => {
  it('gives each command its own answer, in order', async () => {
    const helper = helperThat('process.stdout.write(tree(`read ${String(count)}`) + "\\n");');
    const driver = new MacDriver({ helper, app: 'Notes', pid: 7 });
    const reads = await Promise.all([driver.read(), driver.read(), driver.read()]);
    expect(reads.map((read) => read.root.name)).toEqual(['read 1', 'read 2', 'read 3']);
  });

  it('says so when the helper ends with a command not answered, and starts again for the next', async () => {
    // Answers the first command, and ends at the second with no answer.
    const helper = helperThat(
      'if (count === 2) process.exit(1); process.stdout.write(tree(`read ${String(count)}`) + "\\n");',
    );
    const driver = new MacDriver({ helper, app: 'Notes', pid: 7 });
    expect((await driver.read()).root.name).toBe('read 1');
    await expect(driver.read()).rejects.toThrow(/the helper process ended/);
    // A new process: its count starts again.
    expect((await driver.read()).root.name).toBe('read 1');
  });
});
