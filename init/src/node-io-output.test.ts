import { describe, expect, it, vi } from 'vitest';
import { buildNodeIo } from './node-io.js';
import { SILENT_HOST } from './host.js';

describe('machine-readable init diagnostics', () => {
  it('keeps root and monorepo diagnostics off stdout', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const io = buildNodeIo(process.cwd(), SILENT_HOST, { stderr: true });
      io.print('root diagnostic');
      io.scoped('src').print('nested diagnostic');
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr.mock.calls.map(([line]) => line)).toEqual([
        'root diagnostic\n',
        'nested diagnostic\n',
      ]);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
