/**
 * `init` in a directory with no package.json, once the workspace redirect has found no app below it.
 *
 * Its own module because it is its own flow: nothing here detects a framework, plans steps or runs a
 * package manager. It scopes the project on disk, then either WRITES the connect snippet into a
 * static page it can see whole, or prints the snippet for the stack it recognised (Streamlit,
 * Django, several pages) and stops.
 */

import { join } from 'node:path';
import { PackageManager, Framework } from './detect/detect.js';
import {
  detectDjangoProject,
  detectStreamlitProject,
  djangoSetupMessage,
  noPackageJsonMessage,
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
  connectArgWithToken,
  djangoMiddlewareSnippet,
  reticleConfigContent,
  staticPageSnippet,
  streamlitPageSnippet,
} from './patch/snippets.js';
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
const SNIPPET_ALREADY = `${HTML_INDEX_PATH} already loads the Reticle SDK — nothing to change.`;
const DRY_RUN_PAIRING_TOKEN = 'DRY_RUN_TOKEN_NOT_FOR_USE';

/**
 * Write the snippet into `index.html`, and hand over to setup as a success.
 *
 * This is the path where the snippet is the whole install, proven to connect when pasted. It used to
 * print the snippet and exit 1 with `no_package_json`, which read to the funnel — and to the person —
 * as the setup failing on exactly the path that works.
 */
function wireStaticPage(options: InitOptions, io: InitIo, connect: string): InitResult {
  for (const [path, content] of Object.entries(
    staticTokenFiles(io.host.pairingToken(), (p) => io.readFile(p)),
  )) {
    io.writeFile(path, content);
  }
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
  const streamlit = detectStreamlitProject((file) => io.readFile(file), io.rootFiles());
  // Asked only when Streamlit already said no, so the two can never both claim the page.
  const django =
    !streamlit && detectDjangoProject((file) => io.exists(join(options.cwd, file)), io.rootFiles());
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
      io.print('Dry run: no files written; the snippet uses a placeholder pairing token.');
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
  const connect = connectArgWithToken(
    options.port,
    nonJsProjectId,
    options.dryRun ? DRY_RUN_PAIRING_TOKEN : io.host.pairingToken(),
  );
  // One page at the root is a page we can see whole. Several, or none, is a choice that is not ours.
  if (!streamlit && !django && io.exists(HTML_INDEX_PATH)) {
    writeConfig();
    if (options.dryRun) {
      io.print(staticPageSnippet(connect));
      return { ok: true, applied: 0, manual: 0 };
    }
    // Without the token: the page is the deployable artifact, so the token goes beside it instead.
    return wireStaticPage(options, io, connectArg(options.port, nonJsProjectId));
  }
  io.print(
    // Two genuinely different situations used to share one sentence: a JS developer in the wrong
    // directory, and a project that is not JavaScript at all. The second reads the old wording as
    // a path problem and goes looking for a directory that cannot exist — reported from a
    // Streamlit app, where the search continued into hunting for a browser bundle to inject by
    // hand before the real answer surfaced.
    streamlit
      ? streamlitSetupMessage()
      : django
        ? djangoSetupMessage()
        : noPackageJsonMessage((file) => io.exists(join(options.cwd, file)), io.rootFiles()),
  );
  writeConfig();
  // The message says "add the snippet below". Print the snippet, or the message is the same broken
  // promise in the other direction.
  io.print(
    streamlit
      ? streamlitPageSnippet(connect)
      : django
        ? djangoMiddlewareSnippet(connect)
        : staticPageSnippet(connect),
  );
  // The onboarding funnel had NO instrumentation, so a setup that died here was indistinguishable
  // from someone who never ran the command — the two failure modes with the most different fixes.
  if (!options.dryRun) io.host.reportOutcome({ ok: false, reason: InitFailure.NO_PACKAGE_JSON });
  return { ok: false, applied: 0, manual: 0 };
}
