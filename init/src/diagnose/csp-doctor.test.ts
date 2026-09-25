/**
 * `doctor` reported every check green at an app that could never connect.
 *
 * The desktop findings next door exist for exactly this shape — a Tauri app with the default CSP
 * runs perfectly and never connects — and the WEB version of the same failure had no check at all,
 * despite two independent Next reports in one batch. A named check with a named remedy, or it is
 * not a check.
 */

import { describe, expect, it } from 'vitest';
import { diagnoseObservedWebCsp, diagnoseWebCsp, resolveWebCspFindings } from './csp-doctor.js';

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

  it('does not treat the Next image optimizer policy as a page policy', () => {
    const source = `images: { contentSecurityPolicy: 'script-src none; sandbox' }`;
    expect(diagnoseWebCsp(files({ 'next.config.mjs': source }), PORT)).toEqual([]);
  });
});

describe('diagnoseObservedWebCsp', () => {
  it('reads the policy actually delivered in the document response', () => {
    const findings = diagnoseObservedWebCsp(
      {
        url: 'http://localhost:3000/',
        headers: [`script-src 'self' 'unsafe-inline'; connect-src 'self'`],
        html: '<main>app</main>',
      },
      PORT,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toContain('response header');
    expect(findings[0]?.problem).toContain('connect-src');
  });

  it('finds a blocking meta policy in served HTML regardless of attribute order and quotes', () => {
    const quote = String.fromCharCode(34);
    const findings = diagnoseObservedWebCsp(
      {
        url: 'http://localhost:3000/',
        headers: [],
        html: `<meta content=${quote}default-src 'self'; connect-src 'self'${quote} http-equiv='Content-Security-Policy'>`,
      },
      PORT,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toContain('<meta>');
    expect(findings[0]?.problem).toContain('connect-src');
  });

  it('ignores policies inside repeated or unclosed HTML comments', () => {
    const hidden = `<meta http-equiv='Content-Security-Policy' content='connect-src none'>`;
    const document = (html: string) => ({ url: 'http://localhost:3000/', headers: [], html });
    expect(diagnoseObservedWebCsp(document(`<!-- <!-- ${hidden} -->`), PORT)).toEqual([]);
    expect(diagnoseObservedWebCsp(document(`<!-- ${hidden}`), PORT)).toEqual([]);
  });
});

describe('resolveWebCspFindings', () => {
  const predicted = diagnoseWebCsp(files({ 'vercel.json': 'connect-src self' }), PORT);

  it('prefers an observed clean development page over a config-file prediction', () => {
    expect(resolveWebCspFindings({ predicted, observed: [], connected: false })).toEqual([]);
  });

  it('keeps a config finding when no running page could be observed, but labels it predicted', () => {
    const findings = resolveWebCspFindings({ predicted, connected: false });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.basis).toBe('predicted');
  });

  it('suppresses a blocking-CSP claim once this app has connected', () => {
    expect(resolveWebCspFindings({ predicted, connected: true })).toEqual([]);
  });
});
