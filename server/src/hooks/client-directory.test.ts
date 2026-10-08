import { describe, expect, it } from 'vitest';
import { MCP_CLIENT_DIRECTORY_HEADER } from '@reticlehq/core';
import {
  callingClientDirectory,
  clientDirectoryFromHeader,
  clientDirectoryFromPeer,
  runWithClientDirectory,
} from './client-directory.js';

describe('the directory a calling client names', () => {
  it('is visible for the call and gone afterwards', () => {
    expect(callingClientDirectory()).toBeUndefined();
    const seen = runWithClientDirectory('/work/shop', () => callingClientDirectory());
    expect(seen).toBe('/work/shop');
    expect(callingClientDirectory()).toBeUndefined();
  });

  it('reads an absolute directory and ignores anything else', () => {
    expect(clientDirectoryFromHeader({ [MCP_CLIENT_DIRECTORY_HEADER]: '/work/shop' })).toBe(
      '/work/shop',
    );
    expect(clientDirectoryFromHeader({ [MCP_CLIENT_DIRECTORY_HEADER]: 'shop' })).toBeUndefined();
    expect(clientDirectoryFromHeader({})).toBeUndefined();
  });

  it('ignores a directory named by a peer that is not on this machine', () => {
    const headers = { [MCP_CLIENT_DIRECTORY_HEADER]: '/work/shop' };
    expect(clientDirectoryFromPeer(true, headers)).toBe('/work/shop');
    expect(clientDirectoryFromPeer(false, headers)).toBeUndefined();
  });
});
