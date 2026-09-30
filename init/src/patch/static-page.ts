/**
 * The connect snippet, written INTO a static page rather than printed beside it.
 *
 * A page with no package.json has no build, so the pasted `<script type="module">` is the whole
 * install — proven end to end on a page served by `python3 -m http.server`. `init` used to print it
 * and exit 1 with `no_package_json`, which made the one path that works read as a failure, and left
 * the step to a human who then had to be told where to put it.
 *
 * Two things differ from the printed recipe, both because the file is the deployable artifact:
 *
 * - It runs only on a loopback host. A static file has no development build to strip it, so the
 *   host is the only line between this snippet and a published page; guarded, a published copy
 *   does not even fetch the SDK. The printed bundled-app recipe deliberately does NOT do this
 *   (a hosts-file dev alias defeats it, see html-no-build.test.ts) — that recipe has NODE_ENV.
 * - It is marked, so a re-run recognises its own block and never writes a second one.
 * - It carries no pairing token. The token used to be a literal in the page, so committing or
 *   publishing index.html published it; it now sits in a module beside the page that `init`
 *   gitignores, which the block imports and any static server serves. Absent — a teammate's
 *   checkout, a published copy — the connect goes without one, and the bridge says why it refused.
 */

import { CDN_SDK_URL } from './snippets.js';

/** The page a static site serves at its root, and the one file `init` will write the snippet into. */
export const HTML_INDEX_PATH = 'index.html';

/** The gitignored module beside the page that holds this machine's pairing token. */
export const STATIC_TOKEN_MODULE = 'reticle.local.js';
const GITIGNORE_PATH = '.gitignore';

/** Opens the block `init` writes; a re-run looks for it. */
export const STATIC_SNIPPET_MARKER = '<!-- reticle:connect (dev only, written by reticle init) -->';
const STATIC_SNIPPET_END = '<!-- /reticle:connect -->';

/** Hostnames a developer's own machine serves a page on. */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Signs that the page already connects, whoever put the snippet there — the printed recipe pasted
 * by hand counts as much as our own block.
 */
const ALREADY_CONNECTS = [STATIC_SNIPPET_MARKER, '@reticlehq/browser'];

const BODY_CLOSE = /<\/body>/i;
const HEAD_CLOSE = /<\/head>/i;

/** Whether this page already carries a Reticle connect. */
export function hasStaticSnippet(html: string): boolean {
  return ALREADY_CONNECTS.some((sign) => html.includes(sign));
}

function block(connectArgLiteral: string): string {
  const hosts = LOOPBACK_HOSTS.map((h) => `'${h}'`).join(', ');
  const arg =
    '' === connectArgLiteral
      ? '{ token: local.token }'
      : `{ ...${connectArgLiteral}, token: local.token }`;
  return `    ${STATIC_SNIPPET_MARKER}
    <script type="module">
      if ([${hosts}].includes(location.hostname)) {
        Promise.all([
          import('${CDN_SDK_URL}'),
          import('./${STATIC_TOKEN_MODULE}').catch(() => ({})),
        ]).then(([{ reticle }, local]) => reticle.connect(${arg}));
      }
    </script>
    ${STATIC_SNIPPET_END}
`;
}

/** The token module's content. Rewritten on every run, so a re-minted token is picked up. */
export function staticTokenModule(pairingToken: string): string {
  return (
    `// This machine's Reticle pairing token, written by \`reticle init\`. Gitignored: never commit\n` +
    `// or publish it — each machine runs \`reticle init\` for its own.\n` +
    `export const token = '${pairingToken}';\n`
  );
}

/** The files to write so the token module exists and git ignores it; only what actually changes. */
export function staticTokenFiles(
  pairingToken: string | undefined,
  readFile: (path: string) => string | null,
): Record<string, string> {
  if (pairingToken === undefined || 0 === pairingToken.length) return {};
  const files: Record<string, string> = {};
  const module = staticTokenModule(pairingToken);
  if (readFile(STATIC_TOKEN_MODULE) !== module) files[STATIC_TOKEN_MODULE] = module;
  const ignore = readFile(GITIGNORE_PATH) ?? '';
  const covered = ignore
    .split('\n')
    .some((l) => [STATIC_TOKEN_MODULE, `/${STATIC_TOKEN_MODULE}`].includes(l.trim()));
  if (!covered) {
    files[GITIGNORE_PATH] =
      `${'' === ignore ? '' : ignore.replace(/\n*$/, '\n')}${STATIC_TOKEN_MODULE}\n`;
  }
  return files;
}

/**
 * The page with the snippet added, or null when it already connects.
 *
 * Before `</body>` so the SDK starts on a parsed document; before `</head>` for a page with no body
 * tag, and at the end for a fragment with neither.
 */
export function withStaticSnippet(html: string, connectArgLiteral: string): string | null {
  if (hasStaticSnippet(html)) return null;
  const snippet = block(connectArgLiteral);
  const anchor = BODY_CLOSE.exec(html) ?? HEAD_CLOSE.exec(html);
  if (null === anchor) return `${html.trimEnd()}\n${snippet}`;
  // At the start of the closing tag's own line when it sits alone on one, so its indentation stays
  // with it rather than moving onto the first line of the snippet.
  const lineStart = html.lastIndexOf('\n', anchor.index - 1) + 1;
  const at = '' === html.slice(lineStart, anchor.index).trim() ? lineStart : anchor.index;
  return `${html.slice(0, at)}${snippet}${html.slice(at)}`;
}
