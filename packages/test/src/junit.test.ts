import { describe, expect, it } from 'vitest';
import { toJUnitXml, writeJUnit } from './junit.js';
import { TestStatus } from './constants.js';
import type { FileSystemPort } from '@iris/server';
import type { SpecResult } from './types.js';

const mixed: SpecResult[] = [
  { name: 'passes', status: TestStatus.PASS, durationMs: 12 },
  { name: 'breaks <&>', status: TestStatus.FAIL, durationMs: 7, error: 'no signal & "x"' },
  { name: 'skipped', status: TestStatus.SKIP, durationMs: 0, skipReason: 'no real input' },
];

describe('toJUnitXml', () => {
  it('emits a testsuite with a testcase per spec and failure/skipped elements', () => {
    const xml = toJUnitXml(mixed);
    expect(xml).toContain('<testsuite');
    expect(xml).toContain('tests="3"');
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('skipped="1"');
    expect(xml.match(/<testcase/g)).toHaveLength(3);
    expect(xml).toContain('<failure');
    expect(xml).toContain('<skipped');
  });

  it('XML-escapes attribute and text content', () => {
    const xml = toJUnitXml(mixed);
    expect(xml).toContain('breaks &lt;&amp;&gt;');
    expect(xml).toContain('no signal &amp; &quot;x&quot;');
    expect(xml).not.toContain('breaks <&>');
  });

  it('accepts a custom suite name', () => {
    const xml = toJUnitXml(mixed, { suite: 'my-suite' });
    expect(xml).toContain('name="my-suite"');
  });
});

describe('writeJUnit', () => {
  it('writes the report through the injected FileSystemPort to the given path', async () => {
    const writes: Array<{ path: string; data: string }> = [];
    const fs: Pick<FileSystemPort, 'writeFile'> = {
      writeFile: (path, data) => {
        writes.push({ path, data });
        return Promise.resolve();
      },
    };
    await writeJUnit(fs as FileSystemPort, '/tmp/junit.xml', mixed);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe('/tmp/junit.xml');
    expect(writes[0]?.data).toContain('<testsuite');
  });
});
