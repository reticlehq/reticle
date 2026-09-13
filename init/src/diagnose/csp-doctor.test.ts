/**
 * `doctor` reported every check green at an app that could never connect.
 *
 * The desktop findings next door exist for exactly this shape — a Tauri app with the default CSP
 * runs perfectly and never connects — and the WEB version of the same failure had no check at all,
 * despite two independent Next reports in one batch. A named check with a named remedy, or it is
 * not a check.
 */

import { describe, expect, it } from 'vitest';
import { diagnoseWebCsp } from './csp-doctor.js';

const PORT = 4400;

function files(map: Record<string, string>): (relative: string) => string | undefined {
  return (relative) => map[relative];
}

describe('diagnoseWebCsp', () => {
  it('finds a blocking connect-src in the Next config', () => {
    const findings = diagnoseWebCsp(files({ 'next.config.mjs': `"connect-src 'self'"` }), PORT);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe('next.config.mjs');
  });

  it('finds one in middleware, where a CSP is just as often written', () => {
    const findings = diagnoseWebCsp(files({ 'middleware.ts': `"connect-src 'self'"` }), PORT);
    expect(findings).toHaveLength(1);
  });

  it('finds a meta tag in the root layout', () => {
    const findings = diagnoseWebCsp(
      files({
        'app/layout.tsx': `<meta httpEquiv="Content-Security-Policy" content="connect-src 'self'" />`,
      }),
      PORT,
    );
    expect(findings).toHaveLength(1);
  });

  it('carries a fix that is the literal text to paste', () => {
    const findings = diagnoseWebCsp(files({ 'next.config.js': `"connect-src 'self'"` }), PORT);
    expect(findings[0]?.fix ?? '').toContain('ws://localhost:4400');
    expect(findings[0]?.fix ?? '').toContain('ws://127.0.0.1:4400');
  });

  it('is silent on a project with no CSP anywhere', () => {
    expect(diagnoseWebCsp(files({ 'next.config.js': 'module.exports = {};' }), PORT)).toEqual([]);
  });

  it('is silent when the policy already admits the bridge', () => {
    const source = `"connect-src 'self' ws://localhost:4400 ws://127.0.0.1:4400"`;
    expect(diagnoseWebCsp(files({ 'next.config.js': source }), PORT)).toEqual([]);
  });

  it('reports each offending file once, not each directive', () => {
    const source = `"connect-src 'self'"`;
    const findings = diagnoseWebCsp(
      files({ 'next.config.js': source, 'middleware.ts': source }),
      PORT,
    );
    expect(findings).toHaveLength(2);
    expect(new Set(findings.map((f) => f.file)).size).toBe(2);
  });
});
