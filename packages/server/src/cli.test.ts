import { describe, expect, it } from 'vitest';
import { DRIVE_USAGE, parseDriveArgs } from './cli.js';

const PORT = 7333;
const URL = 'http://localhost:3000';

describe('parseDriveArgs', () => {
  it('parses "drive <url>" into headless driveUrl', () => {
    expect(parseDriveArgs(['drive', URL], PORT)).toEqual({
      kind: 'drive',
      driveUrl: URL,
      headless: true,
      port: PORT,
    });
  });

  it('parses "drive <url> --headed" into headless:false', () => {
    expect(parseDriveArgs(['drive', URL, '--headed'], PORT)).toEqual({
      kind: 'drive',
      driveUrl: URL,
      headless: false,
      port: PORT,
    });
  });

  it('parses "drive --headed <url>" (flag before url)', () => {
    expect(parseDriveArgs(['drive', '--headed', URL], PORT)).toEqual({
      kind: 'drive',
      driveUrl: URL,
      headless: false,
      port: PORT,
    });
  });

  it('drive without a url is a usage error', () => {
    expect(parseDriveArgs(['drive'], PORT)).toEqual({ kind: 'error', message: DRIVE_USAGE });
  });

  it('drive with an unknown flag is a usage error', () => {
    expect(parseDriveArgs(['drive', URL, '--nope'], PORT)).toEqual({
      kind: 'error',
      message: DRIVE_USAGE,
    });
  });

  it('no args defaults to the serve command', () => {
    expect(parseDriveArgs([], PORT)).toEqual({ kind: 'serve', port: PORT });
  });
});
