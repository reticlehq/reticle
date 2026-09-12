import { describe, expect, it } from 'vitest';
import { mutualPairs, nameCollisions, reaches } from '../../scripts/directory-reach.mjs';

import { join } from 'node:path';
import { REPO_ROOT } from './machine/repo-root.js';

/**
 * Which directories in this package reach for which other ones.
 *
 * The directories are now gathered into four groups, by who the code is for:
 *
 *   portal/  the live link to a running app -- the socket, what we know about a tab, driving it
 *   agent/       what an agent talks to -- the tool surface, the MCP door, what a drive produced
 *   command/     what a person runs -- the command line, the daemon's life, setup, updates
 *   features/    the things Reticle does with what it sees -- flows, journal, crawl, and the rest
 *
 * Grouping made the package legible. It did not make it less tangled, and this file exists so
 * nobody mistakes the first for the second. Two numbers are frozen: who reaches for whom, and how
 * many pairs reach for EACH OTHER -- which is the one that says whether a piece could ever leave,
 * because two directories that both need the other cannot be read, moved or tested apart.
 *
 * Neither number may grow. Both may shrink, and shrinking is the work going well.
 *
 * A freeze rather than a rule about which group SHOULD depend on which, because a rule strict enough
 * to be worth having would be red on the day it was written, and a check that is red on day one
 * teaches people to switch it off rather than to fix anything.
 *
 * Imports are RESOLVED, not pattern-matched. An earlier version looked for `../name/`, which reads
 * a cross-group import as landing in the group rather than in the directory inside it, and quietly
 * counted a third of the graph as absent.
 */

/**
 * The graph itself lives in `scripts/directory-reach.mjs`, not here.
 *
 * There are three callers now -- this guard, the browser package's, and `safe-to-group.mjs`,
 * which predicts what both will say. Three copies of one graph computation is three chances for
 * the prediction to disagree with the test it predicts, which would be worse than having no
 * prediction at all.
 */
const SERVER = join(REPO_ROOT, 'server');

/**
 * BEFORE MOVING FILES, ask `node scripts/safe-to-group.mjs <dir> <name...>`.
 *
 * This test is the authority and it answers only AFTER a move, which made the first round of
 * directory grouping a sequence of move, rewrite every import, run this, revert. Three of the
 * first four candidate groups had to be reverted that way -- each one an expensive route to a
 * fact that was sitting in the import graph the whole time.
 *
 * That script answers the same question first. A group is unsafe exactly when some directory it
 * reaches OUT to also reaches back IN to it, which is a mutual pair by definition and the only
 * way a grouping can raise the count below. It is a prediction of this test; this test still
 * decides.
 *
 * What each directory reaches for today. Adding an entry is a decision, which is the point.
 *
 * Before adding one, the question worth asking is whether the thing being reached for is in the
 * right place. Most of the reaches removed from this repo so far turned out to be a file filed
 * somewhere odd rather than a dependency anybody needed.
 */
const REACHES_FOR: Record<string, readonly string[]> = {
  /**
   * Everything about how an assertion becomes a verdict: the grade it earns, where the claim
   * came from, and the verdict itself. Twelve files by that name sat loose in a directory of
   * 138, and the name was already doing the grouping.
   *
   * It is NOT a sink like `facts`, and the ledger is worse than that one's: three edges in,
   * none freed. `assert` reads a session to know what was observed and `act` to know what was
   * done, which is what an assertion is made of, so those two are inherent rather than
   * incidental. What it buys is a directory of twelve files that are one subject, out of a
   * directory that is the largest in the repository.
   *
   * `safe-to-group` said SAFE before the move and the mutual-pair count did not change, which
   * is the property this file actually protects. If a fourth edge ever appears here, the
   * question to ask is whether `assert` has stopped being one subject.
   */
  assert: ['act', 'session'],
  /**
   * Four directories reach `session/facts/`, and the edge COUNT went up while the coupling
   * went down. That is worth stating, because this list counts edges and cannot weigh them.
   *
   * `facts` holds what is known ABOUT a session and computes nothing: the handshake's facts,
   * the ambient observed state, which tab a ref came from, and how a reconnect is recognised.
   * It reaches out to NOTHING -- a pure sink. So `tools`, `bridge`, `crawl` and `session`
   * itself now depend on a dependency-free group of four files instead of on `session`, a
   * 34-file directory that depends on a great deal.
   *
   * The ledger: four edges in, one out. `crawl -> session` is GONE, which is what
   * `safe-to-group` predicted before anything moved, and the mutual-pair count did not move --
   * the property this file actually protects.
   *
   * Depending on a sink is weaker coupling than depending on a hub, and a directory that
   * imports nothing can be read, moved and tested alone. If a later reading disagrees, the
   * thing to re-examine is whether `facts` stayed a sink: the moment it reaches out to
   * anything, this trade stops being one.
   */
  // One way, and it stays one way: the OpenReality adapter reads a live session to answer the
  // protocol's eight questions, and nothing in `session` knows the adapter exists. The mutual-pair
  // count is unchanged by it, which is the test that matters -- a grouping that raises that number
  // is a shorter directory listing bought with a real property.
  realm: ['session'],
  /**
   * The act LEAVES, and why this grouping is allowed where an earlier one was not.
   *
   * A first attempt moved the whole act cluster, `act-tools.ts` included, and the mutual-pair
   * count went 32 -> 34: the tool registry and the act tools need each other, so splitting them
   * bought a shorter directory listing with a real property, and it was reverted.
   *
   * What moved instead is only the files that import NO sibling. That makes the edge strictly
   * one-way by construction -- `tools` reaches for `act`, and `act` can never reach back, because
   * nothing in it imports upward. The three reaches below are the ones these files already had
   * under their old home; they are the same edges, now attributed to the directory that owns them.
   */
  act: ['page-commands', 'capsule', 'input', 'read', 'session'],
  /**
   * The read leaves: what a snapshot or a query LOOKS like, with no opinion about what it means.
   *
   * Same construction as `act` -- nothing here imports a sibling, so `tools -> read` can never
   * become mutual.
   */
  read: [],
  /**
   * What this build could not see, and what it lacks to see it: an absent capability, a coverage
   * identity, an action that produced nothing observable, a missing source marker.
   *
   * The protocol calls this coverage, and it is the half of a verdict every other test format
   * leaves out. Reaches for nothing.
   */
  gaps: [],
  /**
   * The two kinds of form field a replay cannot just re-type: a secret, which must not be
   * recorded, and a file, which has to be found again on disk.
   */
  fields: ['tools'],
  /**
   * What `reticle doctor` prints: the rows, the project line, the hint about Chromium.
   *
   * Worth its own name for a reason the guard made visible. Moving these OUT of `cli` removed
   * `pool -> cli` and `tools -> cli` entirely: neither wanted the command-line at all, both
   * wanted a row to print. That is this guard's own thesis -- most reaches it has removed turned
   * out to be a file filed somewhere odd rather than a dependency anybody needed.
   */
  /**
   * The doctor rows. Two of them moved here from the flat cli directory to sit beside
   * doctor-project-line, and they bring with them the two things a row reads: the session it
   * describes and the version it prints. The cli directory stopped reaching for version at all
   * in the same move, because that reach was only ever these files.
   */
  doctor: ['session', 'version'],
  /**
   * Getting something running and waiting for it: the bridge port, the daemon, the dev server,
   * the relaunch. Everything `reticle init` does between writing files and having a session.
   */
  bringup: ['binding', 'cli', 'daemon', 'launch', 'mcp'],
  /**
   * What the daemon remembers between sessions: which projects have registered, what a previous
   * connection looked like, whether an address smells like somebody's dev server.
   *
   * Moving it out removed `command -> session` and `mcp -> session`. Neither wanted a live
   * session; both wanted the memory of one.
   */
  recall: [],
  /**
   * The filesystem, as a port.
   *
   * Thirteen directories reach for it, and until now every one of them reached for `project` to
   * get there -- a file filed in the feature that happened to need it first. Extracting it
   * removed `cloud -> project` and `command -> project` outright: neither wanted a project, both
   * wanted to read a file.
   *
   * Reaches for nothing itself, which is what a port should do.
   */
  fs: [],
  /**
   * Starting the CLI as a child process and waiting for it.
   *
   * Predicted to free three reaches before it was moved, and it freed exactly those three:
   * `mcp -> cli`, `setup -> cli` and `terminal -> cli` are gone. None of them wanted the
   * command-line surface; each wanted to start a process. Mutual pairs 29 -> 27.
   */
  launch: ['machine', 'identity', 'version'],
  /**
   * Where `.reticle/` is for a given project, and the id derived from it.
   *
   * Freed `capsule -> project` and `visual -> project`: neither wanted the project feature, both
   * wanted to know which directory to write into.
   */
  dir: ['fs'],
  /**
   * Finding the config a command should read, before any command has run.
   *
   * Freed four reaches on `cli`. `license`, `project` and `session` never wanted the
   * command-line; they wanted to know where the configuration is.
   */
  config: ['resolve'],
  /**
   * What version this daemon is, as a fact rather than as a comparison.
   *
   * `version/` is about SKEW -- is the page's build the same as ours, and what to say when it is
   * not. Six directories reached it only to learn our own version number, which is not a
   * comparison at all. Freed `command -> version`, `telemetry -> version` and `update -> version`.
   */
  identity: [],
  /**
   * Which port the daemon is on, resolved once for everybody who needs to reach it.
   *
   * Extracted out of `ports/`, a grouping made earlier in this same audit. Seven directories
   * reached `ports` and wanted only this file; the port HOLDER and the sibling scan are a
   * different question that only the CLI asks. Grouping by theme buried a high-demand file
   * behind two low-demand ones, and the fan-in measure is what caught it afterwards.
   */
  resolve: [],
  /**
   * What a previous connection to this project looked like.
   *
   * Extracted out of `recall/` for the same reason, and named `prior` rather than `memory`
   * because `features/memory` already exists -- caught by the basename-uniqueness guard added
   * earlier in this audit, on a collision introduced by this audit.
   */
  prior: [],
  browser: [],
  peer: [],
  tape: [],
  /**
   * Who is attached to a session, and who may drive it. Reaches for NOTHING -- not even its own
   * parent -- which is the strongest form a group can take: `session` needs it, and it needs
   * nobody, so the edge cannot ever become mutual however either side grows.
   */
  presence: [],
  /**
   * The person in the loop: their review marks, their messages to the agent, and what the panel
   * is told to show them. Reaches for nothing.
   */
  human: [],
  /**
   * What a flow's result MEANS -- whether an assertion still has integrity, who a failure belongs
   * to, why a role drifted. Reaches for nothing, like `presence`, so both edges into it are
   * permanently one-way.
   */
  outcome: [],
  /**
   * Which port a daemon binds, who already holds one, and which siblings are up.
   *
   * Seven directories reach for it, which is the argument for its existing: a question that many
   * parts of a program ask is a thing, and it was seven files in the middle of the CLI. It
   * reaches for nothing itself.
   */
  ports: [],
  /**
   * Talking to the person at the terminal: asking, interrupting, showing progress, recording what
   * was said. Named `terminal` and not `console`, which in a JavaScript codebase means the API.
   *
   * It reaches for four things and that is honest -- it prints daemon state, port state and
   * telemetry notices, because that is what a setup transcript is made of.
   */
  terminal: ['daemon', 'launch', 'resolve', 'telemetry'],
  /** A recorded flow and what became of it: the tape, the rewind, the flake, the halt. */
  recording: [],
  /** What a human wrote on a step, and where they pointed when they wrote it. */
  'annotate-notes': [],
  bridge: [
    'stores',
    'facts',
    'flows',
    'fs',
    'identity',
    'impact',
    'project',
    'session',
    'tape',
    'telemetry',
    'tools',
    'version',
  ],
  capsule: ['dir', 'fs'],
  cli: [
    'answers',
    'binding',
    'suite',
    'change',
    'stores',
    'artifact',
    'auth',
    'bridge',
    'browser',
    'capsule',
    'cloud',
    'daemon',
    'doctor',
    'flows',
    'fs',
    'identity',
    'launch',
    'mcp',
    'outcome',
    'ports',
    'prior',
    'project',
    'resolve',
    'runs',
    'session',
    'setup',
    'tape',
    'tools',
    'update',
  ],
  cloud: ['cli', 'fs', 'intent'],
  command: [
    'answers',
    'lifetime',
    'binding',
    'drive',
    'cli',
    'daemon',
    'change',
    'fs',
    'hunt',
    'identity',
    'launch',
    'license',
    'mcp',
    'prior',
    'resolve',
    'init',
    'telemetry',
    'update',
  ],
  crawl: ['args', 'project', 'tools', 'facts'],
  daemon: ['lifetime', 'binding', 'telemetry'],
  domain: ['args', 'dir', 'flows', 'oracles', 'project', 'tools'],
  ee: ['license'],
  flows: [
    'navigation',
    'suite',
    'change',
    'args',
    'stores',
    'act',
    'annotate-notes',
    'cli',
    'cloud',
    'dir',
    'fields',
    'fs',
    'intent',
    'journal',
    'outcome',
    'project',
    'recording',
    'runs',
    'session',
    'tape',
    'tools',
  ],
  impact: ['cloud', 'session'],
  input: ['args', 'pool', 'telemetry', 'tools'],
  intent: ['dir', 'fs', 'project', 'tools'],
  // What a run artifact is FOR once it exists -- stored, compared, and read back as established
  // fact -- as against the rest of `runs`, which produces one. Named `artifact`, singular, and it
  // must stay singular: `core/src/artifacts` is a different package and a different node, and
  // "correcting" the spelling would give two directories one basename, which is how the reach
  // graph silently collapsed `cli/cloud` into `features/cloud` with every test still passing.
  artifact: ['dir', 'flows', 'fs'],
  // `reticle login` and what it leaves on the machine: the credential store, the signed-in
  // session, and the browser device flow. Named `auth` and deliberately NOT `cloud`, though every
  // file in it is about the cloud -- `features/cloud` already owns that basename, and the reach
  // graph keys on basename, so a second `cloud` would merge the two into one node and every test
  // would still pass. That has happened here once already.
  auth: ['machine', 'cloud'],
  // How the MCP layer's failures reach the agent: recognising a refusal that arrived dressed as
  // a success, and reporting that the tools are gone. What `tools` wanted from `mcp` was these
  // two files and nothing else, which is why lifting them broke the `mcp <-> tools` pair.
  faults: ['telemetry'],
  journal: ['on-disk', 'artifact', 'dir', 'fs', 'project', 'runs'],
  license: ['config'],
  mcp: [
    'binding',
    'daemon',
    'faults',
    'identity',
    'launch',
    'prior',
    'proxy',
    'resolve',
    'telemetry',
    'tools',
    'version',
  ],
  memory: ['args', 'cloud', 'fs', 'project', 'tools'],
  pool: ['browser', 'input', 'telemetry'],
  // `runs` dropped out: what project wanted from it was the artifact, which is what broke the
  // project <-> runs mutual pair and took the count from 24 to 23.
  project: ['args', 'artifact', 'cloud', 'config', 'dir', 'flows', 'fs', 'tools'],
  // The MCP proxy: the transport half of `mcp`, which reaches nothing of its siblings and was
  // therefore extractable without tangling anything. Reaches out to two, reached in from two,
  // and no pair among them is mutual -- which is the only thing that would have raised the count.
  // `telemetry` arrived with `mcp-post-transport`, which is the proxy's POST leg and had been
  // filed beside the proxy rather than in it. Moving it in adds an edge and removes a lie about
  // where that code lives; the count is unchanged either way.
  proxy: ['binding', 'daemon', 'identity', 'telemetry'],
  runs: ['artifact', 'cloud', 'dir', 'flows', 'intent', 'peer', 'project', 'telemetry', 'tools'],
  session: [
    'page-commands',
    'dev-server',
    'args',
    'timing',
    'facts',
    'bridge',
    'config',
    'daemon',
    'gaps',
    'human',
    'impact',
    'input',
    'journal',
    'mcp',
    'ports',
    'presence',
    'prior',
    'recall',
    'resolve',
    'telemetry',
    'tools',
  ],
  // `mcp` dropped out when the proxy files left it: what setup actually wanted from that
  // directory was the proxy, and nothing else. The extraction made an existing dependency
  // legible rather than adding one -- see `would FREE` in scripts/safe-to-group.mjs.
  // `resolve` arrived with 2.14.0: `setup-command` reports the project id in its result, and
  // `readProjectId` lives there. One way, and the same edge `mcp` and `tools` already had -- it
  // is the only module that exports it, so the alternative was a second copy of the reader.
  setup: ['bringup', 'daemon', 'launch', 'probe', 'resolve', 'terminal'],
  telemetry: [
    'cli',
    'daemon',
    'identity',
    'license',
    'peer',
    'prior',
    'resolve',
    'session',
    'tools',
    'update',
  ],
  /**
   * The three flow stores that read and write .reticle/ on disk, moved out of a 35-file directory
   * because each one imports no sibling. They reach the filesystem port and the flow shapes they
   * persist, and nothing in flows is reached back through them.
   */
  stores: ['dir', 'fs', 'outcome', 'project', 'recording'],
  /**
   * Deadlines, and the clock they are measured against. Three files that import nothing at all,
   * which is what let them out of a 27-file directory. stall-clock belongs with them by subject
   * and stayed behind: it is mutual with telemetry, and this rule does not move a file that would
   * carry a knot with it.
   */
  timing: [],
  /**
   * What a caller may pass. Two files that import nothing at all: the spellings one tool accepts
   * from the tool next door, and the bounds a numeric input has to sit inside. Nine directories
   * reach them, which is the argument for a name rather than against one.
   */
  args: [],
  /**
   * The daemon half of `reticle init`: the capabilities the init package cannot know for itself,
   * and what happens after the files are written. Both were flat in setup/, and taking them out
   * is why setup no longer reaches bridge, proxy or telemetry at all — those three reaches were
   * these two files and nothing else.
   */
  init: ['binding', 'bridge', 'bringup', 'launch', 'proxy', 'setup', 'telemetry', 'terminal'],
  /**
   * A file changed: which flows must re-verify, what the gate does about it, and how a
   * save-heavy editor's burst becomes one flush. Four files that import nothing whatsoever,
   * which is what let them out of a 32-file directory.
   */
  change: [],
  /**
   * The whole set rather than one flow: running the suite in parallel over the lease pool,
   * handing it to the hosted runner instead, how much of the declared surface it covered, and
   * what the flake ledger learned from the run.
   */
  suite: ['cloud', 'fs', 'stores', 'tools'],
  /**
   * `reticle drive`. It attaches to a daemon that is already running rather than binding the
   * port itself, which is the whole reason the two files exist and why they reach the daemon,
   * the launcher, the mcp surface and the port table.
   */
  drive: ['binding', 'daemon', 'launch', 'mcp', 'ports'],
  /**
   * This project's dev server: the literal command that starts it, read from the project's own
   * scripts, and which of the usual ports already have something listening. Named dev-server
   * rather than dev because command/dev already owns that basename, and the reach graph keys on
   * the basename alone -- two directories called dev are one node to it, and a mutual pair
   * between them could not be reported at all.
   */
  'dev-server': ['recall', 'resolve'],
  /**
   * The address the daemon lives at: a port this machine will actually let us bind, the IPv6
   * loopback alias that makes `localhost` reach it on every platform, and the three-state answer
   * to what is already on the bridge port. Eight directories reach these three files and they
   * import nothing at all, which is why they were the most-reached flat files in the package.
   * Naming them also untangled init, which no longer reaches daemon for anything else.
   */
  binding: [],
  /**
   * How long a daemon lasts: the log event when the child cannot start, the pid of a predecessor
   * that died without exiting, the beat that turns silence in the log into evidence, whether this
   * one was ever useful to anybody, and how long an idle one is given before it shuts itself
   * down. Five files, none of which imports anything.
   */
  lifetime: [],
  /**
   * Facts and chores about the computer this daemon is running on: the `process.platform` values
   * it actually branches on, where the checkout is, and how to delete a temp directory on an OS
   * that does not release handles promptly. Three files at the package root that import nothing.
   */
  machine: [],
  /**
   * What the journal leaves on the filesystem: the shape of the file the learned ambient map is
   * kept in, which `.reticle/` entries are local state that must never be committed, and how
   * long any of it is kept. Three files that reach the directory layout and the filesystem port
   * and nothing else.
   */
  'on-disk': ['dir', 'fs'],
  /**
   * Finding out what is actually there. The daemon cannot know what a page contains, which
   * loopback address a dev server really answers on when the announced one misses, or whether a
   * live server belonging to this project has already announced itself. Three files that import
   * nothing and are reached only by setup.
   */
  probe: [],
  /**
   * Going somewhere, and what that is honest to report afterwards. A navigation is the action
   * nobody can fully confirm: navigate-result is the envelope that says so, reload-result is
   * what the reload form of it reports, navigate-arrival is how we decide it arrived. The
   * complete family — nothing about navigation is left flat beside it.
   */
  navigation: ['session'],
  /**
   * The last thing a command says. What `gate` means by its exit code, what `open` says when it
   * launched a URL and no session ever appeared, and the sentence `status` owes the user
   * because `init` promised it. Each is one command's human-facing answer, which is a different
   * job from doing the work and drifts if it lives next to it.
   */
  answers: ['session'],
  /**
   * A command sent to the page: whether this page should be asked for it at all, and the
   * in-flight table that correlates the reply, times out the ones that never come back and
   * fails the rest when the socket drops.
   *
   * Named page-commands rather than commands because `command/` already exists one level up and
   * two directory names a single letter apart are a trap for a reader even where the basename
   * guard is satisfied.
   */
  'page-commands': [],
  tools: [
    'navigation',
    'lifetime',
    'args',
    'timing',
    'stores',
    'assert',
    'facts',
    'act',
    'annotate-notes',
    // The model-driven drive: the loop, the model binding and the timeout, and nothing else.
    //
    // Strictly one-way BY CONSTRUCTION, which is why the binding to the tool surface lives here in
    // `tools` rather than beside the loop. `harness` imports nothing from this package at all — it
    // is handed a toolset and a driver — so it is a sink, and `tools -> harness` can never become a
    // mutual pair. Putting the two files that know about TOOLS inside it would have made one on the
    // first commit.
    'artifact',
    'browser',
    'capsule',
    'crawl',
    'daemon',
    'dir',
    'domain',
    'faults',
    'flows',
    'fs',
    'gaps',
    'harness',
    'impact',
    'input',
    'intent',
    'memory',
    'oracles',
    'pool',
    'prior',
    'project',
    'read',
    'recording',
    'resolve',
    'runs',
    'session',
    'tape',
    'telemetry',
    'update',
    'version',
    'visual',
  ],
  update: ['machine', 'identity', 'project', 'telemetry'],
  version: ['identity', 'project', 'tools'],
  visual: ['args', 'dir', 'fs', 'input', 'tools'],
};

/**
 * The pairs that reach for each other -- the shape that makes a directory unmovable.
 *
 * A count rather than a list: the list is derivable and printed on failure, and a hand-written copy
 * would be one more thing to keep in step.
 *
 * ── WHAT THE REMAINING 22 ARE MADE OF ───────────────────────────────────────────────────────────
 * Computed across every pair rather than guessed at, and the answer ends the leaf-extraction
 * phase in this package: **fifteen of the twenty-two hinge on exactly ONE file, and not one of
 * those files is a leaf.** Every one imports a sibling, so the rule that produced the last four
 * reductions -- move only what imports no sibling -- cannot reach any of them.
 *
 * That said seventeen when the count was twenty-four, and the definition was not written down,
 * so re-deriving it took a wrong answer first. It is this: for each mutual pair, count the
 * non-test files in A that import anything under B, and the same for B into A. The pair HINGES
 * when either direction has exactly one such file, because moving that one file would break the
 * pair. Fifteen of twenty-two today. A figure nobody can reproduce is a figure nobody can
 * correct, which is why the method is here and not just the number.
 *
 * Two structures account for nearly all of it, and neither is a misfiling:
 *
 *   - **The tool registry.** `tools.ts` imports every feature's tool module by name, because a
 *     registry that advertises tools has to know them. That is `tools -> crawl`, `-> domain`,
 *     `-> memory`, `-> visual`, and `telemetry -> feedback-tools`. Each feature imports back for
 *     shared helpers, and the pair closes.
 *   - **The shared kit.** `tool-kit` is the thin side of `intent`, `version`, `runs`, `input`,
 *     `project`, `session` and `flows`. It is a leaf by the import-no-sibling rule and a HUB by
 *     the only measure that matters here: it reaches into eight directories, so giving it a node
 *     of its own hands four of them a mutual partner. Measured: frees two, creates four.
 *
 * So the next reduction is a SPLIT of `tool-kit` or of the registry, not another lift. That is a
 * refactor of code thirteen directories depend on, and it is not something to start because a
 * number looks improvable.
 *
 * ── AND THE SAME QUESTION ASKED OF EVERY OTHER PACKAGE ──────────────────────────────────────────
 * Swept with `scripts/safe-to-group.mjs` rather than read off the graph, across roughly
 * twenty-five directories in six packages: server, browser, core, engine, init, spec-runner.
 * The sweep asks two things of every candidate, SAFE and `would FREE`, and the result is short:
 *
 *   - Every remaining candidate that is SAFE is a SINGLE FILE. Moving one file into a new
 *     subdirectory is moving a file. It adds an edge from each importer and buys one freed
 *     reach, and the directory it creates is named after one thing rather than a category.
 *   - Every multi-file group that IS a category came back UNSAFE. In `core/src/wire`, the three
 *     event files are mutual with the package root; the three constants files are mutual with
 *     `artifacts`; `net`/`channel`/`platform` are mutual with `verdict`.
 *
 * One coherent SAFE category existed in the whole repository and it is `portal/session/facts`,
 * extracted the day this note was written. The leaf rule is spent, and now measured spent rather
 * than assumed so -- an earlier version of this claim was made three times from reading the
 * import graph, and the sweep that settles it takes thirty milliseconds per candidate.
 *
 * Asserted with equality rather than `<=`, which is what makes it a RECORD instead of a ceiling.
 * A bound only ever says "no worse"; equality forces the number down in the same commit that
 * earns it, and forces somebody to look when it moves either way. It came down from 24 when
 * `run-store`, `run-diff` and `run-context` left `runs` for `runs/artifact`: `project` had
 * reached into `runs` only for those three, so the pair stopped being mutual. It came down
 * again, 23 to 22, when `mcp-is-error` and `mcp-outage` left `mcp` for `mcp/faults` -- the same
 * shape a third time, since what `tools` wanted from `mcp` was those two files. The move was
 * predicted safe and turned out to be subtractive, which is the pattern worth looking for --
 * see `would FREE` in scripts/safe-to-group.mjs.
 */
const MUTUAL_PAIRS_TODAY = 22;

/**
 * Two directories may not share a name.
 *
 * The reach graph identifies a directory by its BASENAME, so `command/cli/cloud` and
 * `features/cloud` are one node to it. That is not a rounding error: reaches into one are
 * attributed to the other, a mutual pair between them is unreportable, and the count below --
 * the number this whole audit is steered by -- quietly measures a graph that does not exist.
 *
 * Found by walking into it. A grouping created a second `cloud/`, every reach test still passed,
 * and the only symptom was that the new directory appeared to have no reaches at all: they had
 * been credited to its namesake. A guard that can be silently defeated by naming is worse than
 * one that is missing, because it goes on reporting a number.
 *
 * Keyed on the basename rather than fixed by using full paths deliberately. Full paths would make
 * the reach list unreadable -- `agent/tools -> portal/session` twice a line -- and unique
 * short names are worth having for their own sake. This is the price of that, made loud.
 */
describe('directory names in this package are unique', () => {
  it('has no two directories sharing a basename', () => {
    const clashes = nameCollisions(SERVER);
    expect(
      clashes,
      'The reach graph identifies a directory by its basename, so these are one node to it -- ' +
        'their reaches are merged and a mutual pair between them cannot be reported. Rename one, ' +
        'or put the files in the directory that already has the name.',
    ).toEqual([]);
  });
});

describe('the directories in this package know only what they are allowed to know', () => {
  it('finds the directories at all — a check over nothing passes about nothing', () => {
    // Grouping the directories moved every one of them. A scan that silently stopped resolving
    // would report an empty graph, and every check below would pass by having read no code.
    expect(reaches(SERVER).size).toBeGreaterThan(20);
  });

  it('gains no new reach into another directory', () => {
    const found = reaches(SERVER);
    const added: string[] = [];
    for (const [one, targets] of found) {
      for (const other of targets) {
        if (!(REACHES_FOR[one] ?? []).includes(other)) added.push(`${one} -> ${other}`);
      }
    }
    expect(
      added.sort(),
      'A directory here started reaching for one it did not before. Ask first whether the thing it ' +
        'wants is in the right place: most reaches removed from this package so far were a file ' +
        'filed somewhere odd rather than a dependency anybody needed. If it is really necessary, ' +
        'add it to REACHES_FOR.',
    ).toEqual([]);
  });

  it('does not describe reaches that are gone', () => {
    // The other direction, and a separate check because one equality for both would go red when a
    // reach is REMOVED -- and a check that punishes the work going well gets switched off.
    const found = reaches(SERVER);
    const stale: string[] = [];
    for (const [one, targets] of Object.entries(REACHES_FOR)) {
      for (const other of targets) {
        if (true !== found.get(one)?.has(other)) stale.push(`${one} -> ${other}`);
      }
    }
    expect(
      stale.sort(),
      'These reaches no longer exist. Take them out: this list is meant to be read as what is still ' +
        'tangled.',
    ).toEqual([]);
  });

  it('has no more pairs that need each other than it had', () => {
    const pairs = mutualPairs(SERVER);
    expect(
      pairs.length,
      `Two directories that each need the other cannot be read, moved or tested apart. There are ` +
        `now ${String(pairs.length)}, and the recorded number is ${String(MUTUAL_PAIRS_TODAY)}:\n` +
        pairs.map((p) => `  ${p}`).join('\n'),
      // EQUAL, not "at most". A `<=` here is slack, and slack gets spent: this number dropped from
      // 32 to 30 when one grouping untangled two pairs, and nothing would have gone red if the next
      // change had quietly put them back. An improvement that is not recorded is an improvement
      // somebody else pays for twice.
      //
      // So both directions fail. Up means a grouping made coupling worse -- revert it rather than
      // raising the number. Down means something got untangled: lower the constant in the same
      // commit, and the gain is locked in.
    ).toBe(MUTUAL_PAIRS_TODAY);
  });
});
