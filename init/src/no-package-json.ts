/**
 * `init` in a directory with no package.json, once the workspace redirect has found no app below it.
 *
 * Its own module because it is its own flow: nothing here detects a framework, plans steps or runs a
 * package manager. It scopes the project on disk, then either WRITES the connect snippet into a
 * static page it can see whole, or prints the snippet for the stack it recognised (Streamlit,
 * Django, several pages) and stops.
 */

import { dirname, join } from 'node:path';
import { PackageManager, Framework } from './detect/detect.js';
import { PACKAGE_JSON } from './detect/workspace-apps.js';
import {
  detectDjangoProject,
  detectStreamlitProject,
  djangoSetupMessage,
  NoPackageJsonCase,
  noPackageJsonAnswer,
  streamlitSetupMessage,
} from './detect/non-js-project.js';
import { InitFailure } from './diagnose/init-failure.js';
import {
  HTML_INDEX_PATH,
  STATIC_TOKEN_MODULE,
  staticTokenFiles,
  withStaticSnippet,
} from './patch/static-page.js';
import {
  connectArg,
  reticleConfigContent,
  staticPageSnippetWithLocalToken,
} from './patch/snippets.js';
import {
  djangoMiddlewareSnippet,
  pythonConnectArg,
  streamlitPageSnippet,
} from './patch/python-snippets.js';
import { RETICLE_CONFIG_FILE } from './detect/existing-config.js';
import { deriveProjectId } from './project/project-id.js';
import { portMoveDetail, retargetConfigPort, retargetPort } from './plan/port-steps.js';
import { rememberProjectOnDisk } from './project/remember-project.js';
import type { InitIo, InitOptions, InitResult } from './run-types.js';

const SNIPPET_WRITTEN =
  `Wrote the dev-only connect snippet into ${HTML_INDEX_PATH}. It runs only when the page is ` +
  `opened on localhost. This machine’s pairing token is in ${STATIC_TOKEN_MODULE}, which is ` +
  'gitignored — keep it out of anything you publish, and let each teammate run `reticle init` ' +
  'for their own.';
const TOKEN_MODULE_WRITTEN =
  `This machine’s pairing token is in ${STATIC_TOKEN_MODULE}, which is gitignored. Serve it beside ` +
  'the page: the snippet imports it. Keep it out of anything you publish.';
const SNIPPET_ALREADY = `${HTML_INDEX_PATH} already loads the Reticle SDK — nothing to change.`;
/** How far up `init` looks for the app it was run inside. The same bound as the workspace walk. */
const MAX_ANCESTOR_DEPTH = 8;
const HOME_FOLDER =
  'This is your home folder, not a project. Go to the folder of your app (the one with its ' +
  'package.json) and run `reticle init` there.';
const insideApp = (dir: string): string =>
  `No package.json here, but this folder is inside the app at ${dir}. Run init from the app's ` +
  `folder:\n  cd "${dir}" && reticle init`;

/**
 * The wrong-directory answer when the right directory can be named.
 *
 * Discovery looks DOWN for the app. Run from `src/` of that app, it found nothing and said "run
 * `reticle init` from your app's directory" with no path, to a person one folder inside it. The
 * walk up stops at the home folder: a package.json in the home folder is an accident, not an app.
 */
function namedDirectory(io: InitIo): string | undefined {
  const home = io.homeDir();
  let dir = io.cwd();
  if (dir === home) return HOME_FOLDER;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
    const parent = dirname(dir);
    if (parent === dir || parent === home) return undefined;
    if (null !== io.readFile(join(parent, PACKAGE_JSON))) return insideApp(parent);
    dir = parent;
  }
  return undefined;
}

/**
 * Write the snippet into `index.html`, and hand over to setup as a success.
 *
 * This is the path where the snippet is the whole install, proven to connect when pasted. It used to
 * print the snippet and exit 1 with `no_package_json`, which read to the funnel — and to the person —
 * as the setup failing on exactly the path that works.
 */
/** Write the gitignored token module and its ignore line, only where they change. */
function writeTokenModule(io: InitIo): void {
  for (const [path, content] of Object.entries(
    staticTokenFiles(io.host.pairingToken(), (p) => io.readFile(p)),
  )) {
    io.writeFile(path, content);
  }
}

/** The snippet for this kind of project. Each one reads the token at run time. */
function printedSnippet(streamlit: boolean, django: boolean, connect: string): string {
  if (streamlit) {
    return streamlitPageSnippet(pythonConnectArg(connect));
  }
  if (django) {
    return djangoMiddlewareSnippet(pythonConnectArg(connect));
  }
  return staticPageSnippetWithLocalToken(connect);
}

function wireStaticPage(options: InitOptions, io: InitIo, connect: string): InitResult {
  writeTokenModule(io);
  const html = io.readFile(HTML_INDEX_PATH) ?? '';
  // A page that already connects still has its port compared: the snippet bakes the daemon URL, and
  // a re-run with a new `--port` that answered "already" left the page dialling the old daemon.
  const written = withStaticSnippet(html, connect);
  const moved = null === written ? retargetPort(html, options.port) : null;
  const patched = written ?? moved?.code ?? null;
  if (null !== patched) io.writeFile(HTML_INDEX_PATH, patched);
  io.print(
    null !== written
      ? SNIPPET_WRITTEN
      : null !== moved && options.port !== undefined
        ? `Updated ${HTML_INDEX_PATH}: ${portMoveDetail(moved.from, options.port)}.`
        : SNIPPET_ALREADY,
  );
  const outcome = { ok: true, stack: Framework.HTML };
  if (true !== options.deferOutcome) io.host.reportOutcome(outcome);
  return {
    ok: true,
    applied: null === patched ? 0 : 1,
    manual: 0,
    // Setup takes it from here: with `--url` it opens the page and waits for the session, which is
    // the only proof that matters; without one it says the page has no dev server to start.
    context: { appDir: options.cwd, framework: Framework.HTML, packageManager: PackageManager.NPM },
    ...(true === options.deferOutcome ? { outcome } : {}),
  };
}

export function initWithoutPackageJson(options: InitOptions, io: InitIo): InitResult {
  // Relative to the IO's own root, like every other read here (`readFile` below, `HTML_INDEX_PATH`).
  // The real IO resolves it to the same file; joining `options.cwd` onto it only made these checks
  // miss in the in-memory IO the tests use, so no test could tell the branches below apart.
  const existsHere = (file: string): boolean => io.exists(file);
  const streamlit = detectStreamlitProject((file) => io.readFile(file), io.rootFiles());
  // Asked only when Streamlit already said no, so the two can never both claim the page.
  const django = !streamlit && detectDjangoProject(existsHere, io.rootFiles());
  // "Run init from your app's directory" is the whole answer, so stop at it. This used to fall
  // through to the shared tail below: it wrote `.reticle.json` into the directory it had just called
  // wrong, then printed a script-tag snippet under a message that asks for none (#1366).
  const answer = noPackageJsonAnswer(existsHere, io.rootFiles());
  if (!streamlit && !django && answer.kind === NoPackageJsonCase.WRONG_DIRECTORY) {
    io.print(namedDirectory(io) ?? answer.message);
    if (!options.dryRun) io.host.reportOutcome({ ok: false, reason: InitFailure.NO_PACKAGE_JSON });
    return { ok: false, applied: 0, manual: 0 };
  }
  // Scope the project on disk before anything else, so the daemon can serve this page.
  //
  // This path used to print and exit, leaving no `.reticle.json` at all — and the reporter who
  // asked for the Django path had to hand-write one alongside the middleware. Without it the
  // daemon has no config in its own directory, refuses the page's dial, and every downstream
  // symptom points somewhere other than the cause (see #685). The projectId derivation already
  // handles the no-package case: it falls back to the root folder name, fingerprinted by the
  // absolute path so two checkouts stay distinct.
  //
  // Written only when absent. A config a user or an earlier run already placed here is theirs.
  const nonJsProjectId = deriveProjectId(undefined, io.cwd());
  const writeConfig = (): void => {
    if (options.dryRun) {
      io.print('Dry run: no files written.');
      return;
    }
    // Except its port. A re-run with a new `--port` starts the daemon there, and a config still
    // naming the old one sends the agent to a daemon that is no longer running.
    const existingConfig = io.readFile(RETICLE_CONFIG_FILE);
    const moved = null === existingConfig ? null : retargetConfigPort(existingConfig, options.port);
    if (null !== moved && options.port !== undefined) {
      io.writeFile(RETICLE_CONFIG_FILE, moved.code);
      io.print(`Updated ${RETICLE_CONFIG_FILE}: ${portMoveDetail(moved.from, options.port)}.`);
    }
    if (io.exists(RETICLE_CONFIG_FILE)) return;
    io.writeFile(
      RETICLE_CONFIG_FILE,
      reticleConfigContent(Framework.HTML, options.port, nonJsProjectId, io.host.installSource()),
    );
    rememberProjectOnDisk(io, nonJsProjectId, io.cwd(), Date.now());
    io.print(`Wrote ${RETICLE_CONFIG_FILE} (project "${nonJsProjectId}").`);
  };
  // No snippet below holds the token. A printed token stays in terminal history and transcripts.
  const connect = connectArg(options.port, nonJsProjectId);
  // One page at the root is a page we can see whole. Several, or none, is a choice that is not ours.
  if (!streamlit && !django && io.exists(HTML_INDEX_PATH)) {
    writeConfig();
    if (options.dryRun) {
      io.print(staticPageSnippetWithLocalToken(connect));
      return { ok: true, applied: 0, manual: 0 };
    }
    // The page is the deployable artifact, so the token goes beside it instead.
    return wireStaticPage(options, io, connect);
  }
  io.print(
    // Two genuinely different situations used to share one sentence: a JS developer in the wrong
    // directory, and a project that is not JavaScript at all. The second reads the old wording as
    // a path problem and goes looking for a directory that cannot exist — reported from a
    // Streamlit app, where the search continued into hunting for a browser bundle to inject by
    // hand before the real answer surfaced.
    streamlit ? streamlitSetupMessage() : django ? djangoSetupMessage() : answer.message,
  );
  writeConfig();
  // The message says "add the snippet below". Print the snippet, or the message is the same broken
  // promise in the other direction.
  io.print(printedSnippet(streamlit, django, connect));
  // The page snippet imports the token from this module. Python reads the token file instead.
  if (!streamlit && !django && !options.dryRun) {
    writeTokenModule(io);
    io.print(TOKEN_MODULE_WRITTEN);
  }
  // The onboarding funnel had NO instrumentation, so a setup that died here was indistinguishable
  // from someone who never ran the command — the two failure modes with the most different fixes.
  if (!options.dryRun) io.host.reportOutcome({ ok: false, reason: InitFailure.NO_PACKAGE_JSON });
  return { ok: false, applied: 0, manual: 0 };
}
