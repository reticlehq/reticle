/**
 * The bounded tail read, at the one boundary where the OS is allowed to disagree with us.
 *
 * `readFileFrom` sizes its buffer from `fstat` and then reads. Those are two syscalls, and nothing
 * holds the file still between them: a truncation, or a plain short read, returns FEWER bytes than
 * the buffer holds. The buffer comes from `Buffer.allocUnsafe`, whose tail is whatever was last in
 * that heap block — so decoding the whole buffer emits other memory as journal text. It is a
 * correctness bug before it is anything else (the caller parses that garbage as records, and the
 * byte cursor derived from `fstat` then points past bytes nobody ever read), and it cannot be
 * reproduced by racing a real file, so the short read is injected here.
 *
 * The cap half is tested against real files: what it keeps, where it says the text starts, and that
 * it never hands back the front half of a record it cut through.
 */
import { mkdtemp, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeTempDir } from '@/machine/temp-dir.js';
import { createNodeFileSystem, type FileSystemPort } from './fs-port.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

/** Stands in for the stale heap `Buffer.allocUnsafe` hands back — legible in a failure message. */
const STALE_BYTE = 'Z'.charCodeAt(0);

/**
 * A handle that reports `statSize` bytes and then returns only `content`, leaving the rest of the
 * caller's buffer as it found it (dirtied, exactly as an uninitialised allocation arrives).
 */
function shortReadHandle(content: string, statSize: number): FileHandle {
  const payload = Buffer.from(content, 'utf8');
  const handle = {
    stat: () => Promise.resolve({ size: statSize }),
    read: (buffer: Buffer, offset: number, length: number) => {
      buffer.fill(STALE_BYTE);
      const bytesRead = Math.min(length, payload.length);
      payload.copy(buffer, offset, 0, bytesRead);
      return Promise.resolve({ bytesRead, buffer });
    },
    close: () => Promise.resolve(),
  };
  return handle as unknown as FileHandle;
}

describe('readFileFrom — a read shorter than the file it was sized against', () => {
  const fs: FileSystemPort = createNodeFileSystem();
  const line = '{"t":1,"seq":1}\n';

  it('decodes only the bytes the read returned, never the rest of the buffer', async () => {
    vi.mocked(open).mockImplementationOnce(() => Promise.resolve(shortReadHandle(line, 4096)));

    const chunk = await fs.readFileFrom?.('/any/events.jsonl', 0);

    // The old code decoded all 4096 bytes: this line plus 4080 bytes of somebody else's heap.
    expect(chunk?.text).toBe(line);
  });

  it('says where the returned text starts, so a caller can tell a short read from a whole one', async () => {
    vi.mocked(open).mockImplementationOnce(() => Promise.resolve(shortReadHandle(line, 4096)));

    const chunk = await fs.readFileFrom?.('/any/events.jsonl', 0);

    // `size` is what the file claimed; the text is what arrived. A caller that advances its cursor
    // by `size` skips 4080 bytes it never saw — every record in them lost with no report.
    expect(chunk?.size).toBe(4096);
    expect(chunk?.from).toBe(0);
    expect(Buffer.byteLength(chunk?.text ?? '', 'utf8')).toBeLessThan(chunk?.size ?? 0);
  });
});

describe('readFileFrom — the ceiling on one read', () => {
  let root = '';
  let path = '';
  const fs: FileSystemPort = createNodeFileSystem();
  const records = ['{"n":0}', '{"n":1}', '{"n":2}', '{"n":3}'];
  const file = `${records.join('\n')}\n`;
  /** Bytes of the last `count` records, newline included — the tail a capped read should keep. */
  const bytesOfNewest = (count: number): number =>
    Buffer.byteLength(`${records.slice(records.length - count).join('\n')}\n`, 'utf8');

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'reticle-fs-port-'));
    path = join(root, 'events.jsonl');
    await writeFile(path, file, 'utf8');
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  it('returns the whole tail, and no skip, when it fits under the ceiling', async () => {
    const chunk = await fs.readFileFrom?.(path, 0, 1024);

    expect(chunk?.text).toBe(file);
    expect(chunk?.from).toBe(0);
  });

  it('keeps the NEWEST bytes when the tail is over the ceiling', async () => {
    const chunk = await fs.readFileFrom?.(path, 0, bytesOfNewest(2));

    expect(chunk?.text).toBe('{"n":2}\n{"n":3}\n');
  });

  it('starts the text at a record boundary, never mid-record, and says which byte that is', async () => {
    // A ceiling with three records of room and three bytes of slack: the window opens inside
    // record 0, and half a JSON object is not a short record — it is a line that parses as nothing
    // or, worse, as something else. The slack is given up, not the boundary.
    const chunk = await fs.readFileFrom?.(path, 0, bytesOfNewest(3) + 3);

    expect(chunk?.text).toBe('{"n":1}\n{"n":2}\n{"n":3}\n');
    expect(chunk?.from).toBe(Buffer.byteLength(file, 'utf8') - bytesOfNewest(3));
  });

  it('returns nothing rather than a fragment when the capped window holds no record boundary', async () => {
    const chunk = await fs.readFileFrom?.(path, 0, 4);

    expect(chunk?.text).toBe('');
    // Truthful: everything up to here is unreachable, and the caller must be able to see that.
    expect(chunk?.from).toBe(Buffer.byteLength(file, 'utf8'));
  });

  it('is unchanged for a caller that passes no ceiling', async () => {
    const chunk = await fs.readFileFrom?.(path, 8);

    expect(chunk?.text).toBe('{"n":1}\n{"n":2}\n{"n":3}\n');
    expect(chunk?.from).toBe(8);
  });

  it('reads nothing, and never a negative span, for a ceiling of zero', async () => {
    const chunk = await fs.readFileFrom?.(path, 0, 0);

    expect(chunk?.text).toBe('');
    expect(chunk?.from).toBe(Buffer.byteLength(file, 'utf8'));
  });

  it('returns an empty tail at EOF', async () => {
    const chunk = await fs.readFileFrom?.(path, Buffer.byteLength(file, 'utf8'), 1024);

    expect(chunk?.text).toBe('');
    expect(chunk?.from).toBe(Buffer.byteLength(file, 'utf8'));
  });
});
