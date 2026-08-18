/**
 * Turning "no browser session connected" from a dead end into a next action.
 *
 * This is the most consequential sentence in the product. Most sessions never call a Reticle tool at
 * all, and of the ones that do, a large share make exactly ONE call — usually `reticle_sessions` —
 * and stop. Almost none of those ever touched a browser, and this is the session error they hit. The
 * agent asks whether anything is connected, is told no, and leaves.
 *
 * The old message asked the agent to check two things it cannot see from where it stands ("is your
 * app running with the SDK enabled?", "does it point at this port?"). The daemon can actually tell
 * the three cases apart, and each has a different, concrete fix:
 *
 *   - a session was here and went away    -> the tab closed or reloaded; reopen it
 *   - something is listening, never dialled, project not wired -> run `reticle init` in THAT app
 *   - something is listening, project wired -> port mismatch or a stale build; restart the dev server
 *   - nothing is listening anywhere       -> there is no app running; start it
 *
 * Pure: everything it needs is passed in, so the probe that discovers listening ports stays out of
 * the hot resolve() path and this stays unit-testable.
 */

import { DEV_SERVER_PORTS } from '../cli/cli-port.js';

interface NoSessionFacts {
  /** Whether ANY session has connected to this daemon since it booted. */
  everConnected: boolean;
  /** Whether this project has been through `reticle init` (a .reticle.json / projectId is present). */
  initialized: boolean;
  /** Localhost ports with something listening that looks like a dev server. */
  listening: readonly number[];
  /** The port this daemon is on — half of the mismatch the old message asked about. */
  port: number;
  /**
   * The directory `initialized` was decided in, named in the message when it is known.
   *
   * "There is no `.reticle.json`" is only ever true OF A DIRECTORY, and a reader who cannot see
   * which one has to guess whether the claim is about their app at all — reported by someone whose
   * app lives in `src/admin` while the daemon stands at the repo root.
   */
  directory?: string;
  /**
   * This daemon has reaped at least one EXPIRED pooled lease.
   *
   * Deliberately not "the session that just vanished was that lease" — nothing knows that. It is
   * evidence, not proof, and the message below is worded accordingly.
   */
  leaseExpired?: boolean;
  /**
   * The port `.reticle.json` configures for this project, when there is one.
   *
   * Half of a mismatch the daemon can settle rather than hint at: it knows the port it bound, and
   * this is the number the app's SDK was built to dial. `doctor` already compares them and prints a
   * precise line; the agent reading `why` was getting "check that the port matches" instead.
   *
   * Absent means no config, or one without a port, which is NOT a mismatch: a plugin-wired app has
   * no `.reticle.json` at all and is working perfectly.
   */
  projectPort?: number;
  /**
   * Every `.reticle.json` found by searching outward from this daemon's directory — up to the repo
   * root, then through the conventional workspace locations under it. See cli/config-discovery.ts.
   *
   * The daemon's cwd is an artifact of how the editor launched it, so its emptiness says nothing
   * about the user's project. Reported from a Cursor monorepo: the daemon stood in the user's home
   * directory, the config sat in `apps/web`, and the message concluded the project was not wired.
   *
   * Present and non-empty turns "there is no config" into "here is where it is". Present and empty
   * is a much stronger claim than the old one, because the search was not confined to one directory
   * — which is why `searchedDirectories` is reported alongside it rather than left implicit.
   */
  discoveredConfigs?: readonly string[];
  /** Directories the search above actually examined. Names what "we looked" means. */
  searchedDirectories?: readonly string[];
}

/** At most `limit` paths, comma-joined, with an honest tail when there are more. */
function listPaths(paths: readonly string[], limit: number): string {
  const shown = paths.slice(0, limit).join(', ');
  const rest = paths.length - limit;
  return rest > 0 ? `${shown}, and ${String(rest)} more` : shown;
}

/**
 * Every branch ends with this, and `recoveryFor` keys on it to suppress the generic no-session
 * recovery: a message that already carries its own next action must not be handed a second, more
 * generic one that contradicts it.
 */
export const SELF_RECOVERING_MARKER =
  'Then call reticle_sessions again — it will appear within a second of the page loading.';
const RETRY = SELF_RECOVERING_MARKER;

/**
 * The way out that needs no human at all.
 *
 * `reticle_lease` opens a browser Reticle drives itself, instead of waiting for somebody's tab to
 * dial in. In the field it is the single strongest predictor of a session that works: sessions that
 * use it drive an order of magnitude more tool calls than those that do not, they account for a
 * disproportionate share of every bug found, and no single-call bounce has ever used one. It is also
 * advertised on no profile except `full`, so an agent only ever finds it if it already knew it
 * existed. Naming it HERE puts it in front of the agent at the one moment it is the answer, and
 * costs nothing on the turns when it is not.
 *
 * Only offered when the app is known to carry the SDK: leasing an uninstrumented app just burns a
 * browser and comes back `ready:false`.
 */
const SELF_SERVE =
  'You do not have to wait for the human: reticle_lease {action:"acquire", url} opens a browser ' +
  'Reticle drives itself, and returns a sessionId you can use immediately (reach it with ' +
  'reticle_run {tool:"reticle_lease"} if it is not advertised directly; release it when you finish).';

/**
 * The ports the scan actually covers, rendered for the message.
 *
 * Derived from DEV_SERVER_PORTS rather than re-typed: a message that lists ports the scan does not
 * check, or omits ones it does, is a new version of the same defect — a confident claim about
 * evidence that was never gathered.
 */
/**
 * The one cause that produces a PERFECTLY healthy everything and still never connects.
 *
 * The SDK refuses to dial from a page that is not on localhost unless `allowNonLocalhost` is set.
 * That is deliberate — Reticle must not be reachable from a page it does not trust — but the refusal
 * happens page-side, so the daemon sees only silence, `doctor` sees only a healthy daemon, and every
 * checklist item passes. Reported from the field by an agent on a hosts-file alias (the normal setup
 * for white-label and multi-tenant apps): the whole setup was lost to a flag named in no checklist,
 * and `init`'s own fallback snippet guards on `hostname === 'localhost'`, so on such a host the
 * connect never runs and there is not even a console line to find.
 *
 * Only offered on the wired-and-listening branch: that is where a correctly installed app that
 * cannot connect actually lands.
 */
const NON_LOCALHOST_GATE =
  'One more cause that leaves every other check healthy: if the app is served on anything other ' +
  'than localhost (a hosts-file alias, a LAN IP, a tunnel), the SDK refuses to connect unless it ' +
  'is given `allowNonLocalhost: true` — the refusal is page-side, so nothing here can see it. ' +
  "Check the browser console for that message and pass the flag in the app's reticle.connect().";

const SCANNED_PORTS = [...DEV_SERVER_PORTS].join(', ');

/**
 * The commonest first-run state there is, and until #320 the message named it nowhere.
 *
 * Reticle sees a page only once a browser has LOADED it. A wired app that nobody has opened produces
 * exactly the same empty list as a broken install, and the reporter who hit it spent an afternoon
 * re-verifying their init output, diffing their Vite config and curling their own page before
 * discovering that one `reticle open` fixed it instantly.
 */
const OPEN_THE_APP =
  'Reticle only ever sees a page that is LOADED, so the commonest cause by a distance is that no ' +
  "browser has opened the app yet: run `reticle open <url>` with the app's own URL (or ask the " +
  'human to open it).';

/**
 * What a machine-wide port scan can and cannot say.
 *
 * It finds listeners anywhere on localhost and knows nothing about who owns them. The old wording
 * spent that as evidence — "something IS listening on port 5173, 8000, 8080, SO a server is up and
 * has never dialled this daemon" — about three ports that belonged to three other repositories on
 * the reporter's machine, while their own app sat on a port the scan does not cover. On any machine
 * running more than one instrumented repo, which is the normal case here, that inference is unsound.
 */
function unattributedListeners(listening: readonly number[]): string {
  if (0 === listening.length) {
    return (
      `No listener found that I can attribute to this project: the scan covers ${SCANNED_PORTS} ` +
      'across the whole machine, so an app on any other port is invisible to it.'
    );
  }
  return (
    `Something is listening on port ${listening.join(', ')}, but I cannot attribute any of it to ` +
    `this project: that is a machine-wide scan of ${SCANNED_PORTS}, so on a machine running more ` +
    "than one repo those are as likely to be somebody else's dev server, and the app's own port " +
    'may not be in the set at all. Treat them as unattributed rather than as evidence.'
  );
}

/**
 * The mismatch, stated with both numbers, when we can actually see one. Empty otherwise.
 *
 * Leading space so the caller can concatenate it unconditionally without producing a double space
 * in the common case where there is nothing to say.
 */
function portMismatchClause(facts: NoSessionFacts): string {
  const configured = facts.projectPort;
  if (configured === undefined || configured === facts.port) return '';
  return (
    ` They already disagree: \`.reticle.json\` says port ${String(configured)} and this daemon is` +
    ` on ${String(facts.port)}, so the SDK is dialling ${String(configured)} and nothing is there.` +
    ` Either restart the daemon on ${String(configured)}, or update \`.reticle.json\` to` +
    ` ${String(facts.port)} and restart the dev server so the app picks it up.`
  );
}

export function diagnoseNoSession(facts: NoSessionFacts): string {
  const { everConnected, initialized, listening, port } = facts;
  // Named when known: a claim about a missing file is a claim about ONE directory.
  const where =
    facts.directory === undefined
      ? 'the directory this daemon is running in'
      : `the directory this daemon is running in (${facts.directory})`;

  if (everConnected) {
    // A reaped lease first, because it is the one cause we have POSITIVE evidence for. Reported
    // from the field (#157): an aged-out lease produced "the tab was closed … ask the human to
    // reopen the app", which is wrong on every clause — there is no human tab, and the recovery it
    // names is unavailable to the caller while the one that works goes unmentioned. The reporter
    // went looking for a port mismatch. Hedged rather than swapped: a human tab may ALSO have
    // closed, and this does not know which session went.
    if (true === facts.leaseExpired) {
      return (
        'no browser session connected, but one WAS connected to this daemon earlier, so the wiring ' +
        'is correct. This daemon has expired at least one pooled lease, so the likeliest cause is ' +
        'that a lease you were using aged out; a lease is a headless context, not a human tab, and ' +
        'it takes its cookies with it (so an authenticated app needs signing in again). Re-acquire ' +
        'with reticle_lease {action:"acquire", url} and carry on. If you were driving a human tab ' +
        `instead, it went away — reopen it or run \`reticle open\`. ${RETRY}`
      );
    }
    return (
      'no browser session connected, but one WAS connected to this daemon earlier, so the wiring ' +
      'is correct. The tab was closed, navigated away, or hard-reloaded. Ask the human to reopen ' +
      `the app (or run \`reticle open\`), or reload the tab. ${SELF_SERVE} ${RETRY}`
    );
  }

  if (0 === listening.length) {
    // Lead with the stronger EVIDENCE, and do not overstate what it is.
    //
    // `initialized` is one thing only: whether a `.reticle.json` sits in the directory this daemon
    // is running in. It is NOT "this project has never been through `reticle init`", and the two
    // come apart constantly — a monorepo whose daemon runs at the root while the app lives in
    // `apps/web`, or any app wired by the babel/vite plugin rather than by `init`. An earlier
    // version of this branch asserted the strong claim and led with it, on the reasoning that it was
    // a certainty while the port scan was a guess. It is not a certainty. Caught driving Reticle's
    // OWN repo, where the message told an agent the project had never been through `init` about a
    // fixture that is instrumented and working — "the one sentence I was most likely to act on was
    // wrong", which is the exact failure this whole file exists to prevent.
    //
    // So: report what was actually checked, name the directory, and name the case where the absence
    // is expected rather than diagnostic.
    if (!initialized) {
      const found = facts.discoveredConfigs ?? [];
      const searched = facts.searchedDirectories ?? [];
      // What the second half says depends on what the search actually turned up, because the three
      // cases call for three different next actions and the old single sentence covered only one.
      const configHalf =
        found.length > 0
          ? // The reported case: the config exists, just not where this daemon stands. Naming the
            // paths is the whole point — an agent can pick between two, and cannot pick from
            // "there is none". Never silently choose one here.
            `(2) This daemon's directory has no \`.reticle.json\`, but ${
              1 === found.length ? 'one exists' : `${String(found.length)} exist`
            } in this repo: ${listPaths(found, 4)}. The daemon's directory is set by whatever ` +
            'launched it and often has nothing to do with the app, so this is very likely a ' +
            `wired project rather than an uninitialised one. ${
              1 === found.length
                ? 'Restart the dev server from that directory, or point the daemon at it.'
                : 'Pick the one for the app being worked on, and restart the dev server there.'
            }`
          : searched.length > 0
            ? // Nothing found, but the search was wide. This is now a real claim about the project
              // rather than about our cwd, so it can be stated plainly — with where we looked, so
              // the reader can see whether their app was even in scope.
              `(2) No \`.reticle.json\` anywhere we looked (${listPaths(searched, 4)}). That is ` +
              "the file `reticle init` writes, so the app may carry no Reticle SDK — though an app " +
              'wired by the Vite or Babel plugin carries the SDK without that file at all. If the ' +
              'app lives outside those directories, run `reticle init` in it.'
            : // No search result at all: an older caller, or discovery not run. Keep the previous
              // wording rather than overstate what one directory can prove.
              `(2) There is no \`.reticle.json\` in ${where}. That is the ` +
              "file `reticle init` writes, so the app may carry no Reticle SDK — but check the " +
              "app's OWN directory before re-running `init`: in a monorepo the daemon often runs " +
              'at the root while the app lives in a subdirectory, and an app wired by the Vite or ' +
              'Babel plugin carries the SDK without that file at all.';

      return (
        'no browser session connected. Two things to weigh, and neither of them is proof. ' +
        `(1) Nothing is listening on the ports Reticle scans (${SCANNED_PORTS}), so the dev server ` +
        'may not be running — ask the human to start it (`npm run dev`). That scan is narrow ' +
        'though: a server on any other port is invisible to it, so if the app IS running, ask for ' +
        'its URL rather than assuming it is down, and open it with `reticle open <url>`. ' +
        `${configHalf} ${RETRY}`
      );
    }
    return (
      `no browser session connected, and this daemon has never seen one. ${OPEN_THE_APP} ` +
      'Nothing is listening on the ports Reticle scans ' +
      `(${SCANNED_PORTS}) either, and the most common reason for that is a dev server that is not ` +
      'running: ask the human to start it (`npm run dev`), then open the app in a browser. ' +
      // The caveat is here rather than omitted because the scan is NARROW, and the old sentence
      // spent its confidence as though an empty result were proof of absence. Reported twice: a
      // scripted drive of 2.5.0 asserted the app was not running while it served 200 on :7699, and
      // an agent was told nothing was listening while a dev server answered on :5000 under a custom
      // hostname. The common defaults have since been added to the scanned set, which narrows the
      // gap and cannot close it — anything passed to `--port` is still invisible.
      'That scan is narrow, so it is not proof: a server on any other port is invisible to it. If ' +
      // Deliberately NOT offering reticle_lease here, and a test pins that: a lease opens a URL, and
      // if nothing is listening there is nothing at any URL to open. Asking for the real one is the
      // only move that can recover the :7699 case.
      'the app IS running, ask the human for its URL rather than assuming it is down. ' +
      // Reachable only for a project that HAS been through `init` — the uninstrumented case is
      // answered above, leading with that certainty instead of behind this scan's guess.
      `${RETRY}`
    );
  }

  if (!initialized) {
    return (
      'no browser session connected, and this daemon has never seen one. ' +
      `What was actually checked: there is no \`.reticle.json\` in ${where}. That is the file ` +
      '`reticle init` writes, so the app may carry no Reticle SDK — but it is not proof, and the ' +
      'same absence is expected in a monorepo whose daemon runs at the root while the app lives in ' +
      "a subdirectory, or in an app wired by the Vite or Babel plugin. Check the app's OWN " +
      'directory: if it has no config, run `reticle init` there and restart the dev server; if it ' +
      'has one, the app is wired and simply has no page open — `reticle open <url>`. ' +
      `${unattributedListeners(listening)} ${RETRY}`
    );
  }

  return (
    'no browser session connected, and this daemon has never seen one for this project, which is ' +
    `wired for Reticle. ${OPEN_THE_APP} ${unattributedListeners(listening)} ` +
    'If the page IS open and still does not appear, the app is either serving a build made before ' +
    `the wiring landed or dialling a different daemon than this one (on ${String(port)}): restart ` +
    "the dev server, hard-reload the page, and check that the app's reticle port matches " +
    `${String(port)}.${portMismatchClause(facts)} ${NON_LOCALHOST_GATE} ${SELF_SERVE} ${RETRY}`
  );
}
