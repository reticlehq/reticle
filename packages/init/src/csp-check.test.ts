/**
 * A strict CSP blocks the bridge and nothing on our side ever knows.
 *
 * Two independent reports, both Next, both on the same release: `init` reports every wiring step
 * successful, the SDK mounts, the dial URL is built correctly, and the browser refuses the WebSocket
 * because `connect-src` does not admit the bridge origin. The violation appears only in the
 * browser's own console, which nothing on the Reticle side reads — so `status` and `doctor` stay
 * green while the app is permanently unreachable.
 *
 * A setup step that exits 0 while leaving the user broken is the worst failure mode this repo has,
 * and this is that step. The check is a text scan, deliberately: `headers()` is a function we cannot
 * execute from `init`, and the thing worth finding is the policy string a developer typed.
 *
 * The rule it enforces is narrow on purpose. It fires only when a `connect-src` is present AND does
 * not admit the bridge — never on a project with no CSP, and never on one whose policy already
 * covers us. A false warning here costs exactly what a false green costs, in the other direction.
 */

import { describe, expect, it } from 'vitest';
import { cspConnectSrcProblem, devCspAddition } from './csp-check.js';

const PORT = 4400;

describe('cspConnectSrcProblem', () => {
  it('says nothing about a file with no CSP at all', () => {
    expect(
      cspConnectSrcProblem('module.exports = { reactStrictMode: true };', PORT),
    ).toBeUndefined();
  });

  it('says nothing about a connect-src that already admits the bridge on localhost', () => {
    const source = `"Content-Security-Policy": "connect-src 'self' ws://localhost:4400 ws://127.0.0.1:4400"`;
    expect(cspConnectSrcProblem(source, PORT)).toBeUndefined();
  });

  it('flags a connect-src that excludes the bridge', () => {
    const source = `value: "default-src 'self'; connect-src 'self' https://api.example.com"`;
    expect(cspConnectSrcProblem(source, PORT)).toBeDefined();
  });

  it('flags a connect-src that names localhost over http but not over ws', () => {
    // A real reported shape: the app allows its own API over http and the WebSocket is still blocked,
    // because `ws:` is a different scheme and CSP does not infer it.
    const source = `connect-src 'self' http://localhost:4400`;
    expect(cspConnectSrcProblem(source, PORT)).toBeDefined();
  });

  it('accepts a wildcard scheme source that genuinely admits any ws origin', () => {
    expect(cspConnectSrcProblem(`connect-src 'self' ws:`, PORT)).toBeUndefined();
  });

  it('accepts a bare `*`, which admits everything', () => {
    expect(cspConnectSrcProblem(`connect-src *`, PORT)).toBeUndefined();
  });

  it('reads a CSP meta tag as well as a config value', () => {
    const html = `<meta http-equiv="Content-Security-Policy" content="connect-src 'self'">`;
    expect(cspConnectSrcProblem(html, PORT)).toBeDefined();
  });

  it('names BOTH hosts in the problem, since the SDK may dial either', () => {
    const problem = cspConnectSrcProblem(`connect-src 'self'`, PORT) ?? '';
    expect(problem).toContain('ws://localhost:4400');
    expect(problem).toContain('ws://127.0.0.1:4400');
  });

  it('checks the port the daemon is actually on, not a hardcoded one', () => {
    const problem = cspConnectSrcProblem(`connect-src 'self'`, 4711) ?? '';
    expect(problem).toContain('4711');
  });

  it('is satisfied by a policy that admits localhost on the right port only', () => {
    expect(
      cspConnectSrcProblem(`connect-src ws://localhost:4400 ws://127.0.0.1:4400`, 4711),
    ).toBeDefined();
  });
});

describe('devCspAddition', () => {
  it('is the exact text to paste, not a description of what to do', () => {
    const addition = devCspAddition(PORT);
    expect(addition).toContain('ws://localhost:4400');
    expect(addition).toContain('ws://127.0.0.1:4400');
    expect(addition).toContain('connect-src');
  });

  it('says out loud that it is development-only', () => {
    expect(devCspAddition(PORT)).toMatch(/development|dev only|NODE_ENV/i);
  });
});
