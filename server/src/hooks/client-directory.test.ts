import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCP_CLIENT_DIRECTORY_HEADER } from '@reticlehq/core';
import {
  callingClientDirectory,
  clientDirectoryFromHeader,
  clientDirectoryFromPeer,
  runWithClientDirectory,
} from './client-directory.js';

/** A project directory, absolute on whichever platform runs the test (drive-rooted on Windows). */
const SHOP = resolve('/work/shop');

describe('the directory a calling client names', () => {
  it('is visible for the call and gone afterwards', () => {
    expect(callingClientDirectory()).toBeUndefined();
    const seen = runWithClientDirectory(SHOP, () => callingClientDirectory());
    expect(seen).toBe(SHOP);
    expect(callingClientDirectory()).toBeUndefined();
  });

  it('reads an absolute directory and ignores anything else', () => {
    expect(clientDirectoryFromHeader({ [MCP_CLIENT_DIRECTORY_HEADER]: SHOP })).toBe(SHOP);
    expect(clientDirectoryFromHeader({ [MCP_CLIENT_DIRECTORY_HEADER]: 'shop' })).toBeUndefined();
    expect(clientDirectoryFromHeader({})).toBeUndefined();
    expect(clientDirectoryFromHeader({ [MCP_CLIENT_DIRECTORY_HEADER]: '%' })).toBeUndefined();
  });

  it('decodes a percent-encoded path, which is how a non-ASCII directory fits in a header', () => {
    const project = resolve('/work/项目');
    const encoded = encodeURIComponent(project);
    expect([...encoded].every((char) => char.charCodeAt(0) < 128)).toBe(true);
    expect(clientDirectoryFromHeader({ [MCP_CLIENT_DIRECTORY_HEADER]: encoded })).toBe(project);
  });

  it('ignores a directory named by a peer that is not on this machine', () => {
    const headers = { [MCP_CLIENT_DIRECTORY_HEADER]: SHOP };
    expect(clientDirectoryFromPeer(true, headers)).toBe(SHOP);
    expect(clientDirectoryFromPeer(false, headers)).toBeUndefined();
  });
});
