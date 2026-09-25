/**
 * `doctor`'s web CSP check — the sibling of the desktop one next door.
 *
 * The desktop findings exist because a Tauri app with the default CSP runs perfectly and never
 * connects. The WEB version of that failure had no check at all, and it arrived twice in one batch
 * of field reports: two Next apps where `init` printed success for every step, the SDK mounted, the
 * dial URL was right, and the browser silently refused the WebSocket because `connect-src` excluded
 * the bridge. The violation is reported in the browser's console and nowhere else, so every check on
 * this side stayed green while the app was permanently unreachable.
 *
 * Reads the files a CSP is actually written in, by name — a full source scan would be slower and
 * would find policy strings in test fixtures and documentation.
 */

import {
  cspConnectSrcProblem,
  cspInlineScriptProblem,
  devCspAddition,
  externalScriptRemedy,
} from './csp-check.js';

/** Read a project-relative file, or undefined when it is absent/unreadable. */
type ReadFile = (relative: string) => string | undefined;

export const CspBasis = {
  OBSERVED: 'observed',
  PREDICTED: 'predicted',
} as const;

export interface CspDiagnosis {
  /** Which file to look at. */
  file: string;
  /** What is wrong, in one line. */
  problem: string;
  /** Exactly what to add — copy-pasteable, with the port actually in use. */
  fix: string;
  /** Whether the policy was read from the served document or inferred from project source. */
  basis: (typeof CspBasis)[keyof typeof CspBasis];
}

export interface ObservedWebDocument {
  url: string;
  headers: readonly string[];
  html: string;
}

/**
 * The places a Content-Security-Policy gets written in a JS app.
 *
 * Next config and middleware cover `headers()` and the edge-middleware style; the layouts and the
 * plain `index.html` cover the `<meta http-equiv>` style. Both reported cases were in this list.
 */
export const CSP_FILES: readonly string[] = [
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'middleware.ts',
  'middleware.js',
  'src/middleware.ts',
  'app/layout.tsx',
  'app/layout.js',
  'pages/_document.tsx',
  'pages/_document.js',
  'index.html',
  'public/index.html',
  // Vite puts the entry HTML at the project root; electron-vite and Tauri put the RENDERER's one
  // under src/. MarkText declares its policy in `src/renderer/index.html`, and a desktop app is the
  // likeliest place to meet a strict CSP at all — Electron's own security guidance asks for one.
  'src/index.html',
  'src/renderer/index.html',
  'vercel.json',
  'netlify.toml',
];

/**
 * Next's `images.contentSecurityPolicy` is sent only with optimized images, never with the page.
 * Treating it as a document policy tells a working app to weaken a header that cannot block it.
 */
function pagePolicySource(file: string, source: string): string {
  if (!file.startsWith('next.config.')) return source;
  return source.replace(/contentSecurityPolicy\s*[:=]\s*(['\x22`])[\s\S]*?\1/g, '');
}

export function diagnoseWebCsp(
  read: ReadFile,
  port: number,
  alsoCheck: readonly string[] = [],
): CspDiagnosis[] {
  const findings: CspDiagnosis[] = [];
  for (const file of [...alsoCheck, ...CSP_FILES]) {
    const raw = read(file);
    if (raw === undefined) continue;
    const source = pagePolicySource(file, raw);
    // `script-src` first, because it is the earlier failure. A policy that blocks the inline
    // snippet means there is no SDK at all, so a `connect-src` finding on the same file would be
    // describing a socket that is never opened -- true, and the wrong thing to fix first (#679).
    const inline = cspInlineScriptProblem(source, port);
    if (inline !== undefined) {
      findings.push({
        file,
        problem: inline,
        fix: externalScriptRemedy(),
        basis: CspBasis.PREDICTED,
      });
      continue;
    }
    const problem = cspConnectSrcProblem(source, port);
    if (problem === undefined) continue;
    findings.push({ file, problem, fix: devCspAddition(port), basis: CspBasis.PREDICTED });
  }
  return findings;
}

function observedFinding(policy: string, file: string, port: number): CspDiagnosis | undefined {
  const inline = cspInlineScriptProblem(policy, port);
  if (inline !== undefined) {
    return {
      file,
      problem: inline,
      fix: externalScriptRemedy(),
      basis: CspBasis.OBSERVED,
    };
  }
  const connect = cspConnectSrcProblem(policy, port);
  return connect === undefined
    ? undefined
    : {
        file,
        problem: connect,
        fix: devCspAddition(port),
        basis: CspBasis.OBSERVED,
      };
}

function attributeValue(tag: string, name: string): string | undefined {
  const pattern = new RegExp(
    `\\b${name}\\s*=\\s*(?:\\x22([^\\x22]*)\\x22|'([^']*)'|([^\\s>]+))`,
    'i',
  );
  const match = pattern.exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

/** CSP meta policies from the document the development server actually returned. */
function withoutHtmlComments(html: string): string {
  const visible: string[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf('<!--', cursor);
    if (-1 === start) {
      visible.push(html.slice(cursor));
      break;
    }
    visible.push(html.slice(cursor, start));
    const end = html.indexOf('-->', start + 4);
    if (-1 === end) break;
    cursor = end + 3;
  }
  return visible.join('');
}

function metaPolicies(html: string): string[] {
  const withoutComments = withoutHtmlComments(html);
  const policies: string[] = [];
  for (const match of withoutComments.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const equivalent = attributeValue(tag, 'http-equiv');
    if (equivalent?.toLowerCase() !== 'content-security-policy') continue;
    const content = attributeValue(tag, 'content');
    if (content !== undefined && content.length > 0) policies.push(content);
  }
  return policies;
}

/** Diagnose only policies observed on the served development document. */
export function diagnoseObservedWebCsp(
  document: ObservedWebDocument,
  port: number,
): CspDiagnosis[] {
  const findings: CspDiagnosis[] = [];
  for (const policy of document.headers) {
    const found = observedFinding(policy, `response header at ${document.url}`, port);
    if (found !== undefined) findings.push(found);
  }
  for (const policy of metaPolicies(document.html)) {
    const found = observedFinding(policy, `<meta> in ${document.url}`, port);
    if (found !== undefined) findings.push(found);
  }
  return findings;
}

/** Runtime evidence outranks source prediction; a connected SDK disproves a blocking policy. */
export function resolveWebCspFindings(input: {
  predicted: readonly CspDiagnosis[];
  observed?: readonly CspDiagnosis[];
  connected: boolean;
}): CspDiagnosis[] {
  if (input.connected) return [];
  return [...(input.observed ?? input.predicted)];
}
