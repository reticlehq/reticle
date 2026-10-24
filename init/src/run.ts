/**
 * The impure shell for `reticle init`: gather project files via an injected IO surface, build the
 * plan (pure), optionally write the apply-steps, and print a human-readable report. All filesystem
 * access goes through `InitIo` so the orchestration is unit-testable with an in-memory IO.
 */
import { OnboardingPhase, OnboardingStepStatus } from '@reticlehq/core/telemetry';
import type { InitOptions, InitIo, InitResult, InitContext } from './run-types.js';
import { explainInstallFailure } from './diagnose/install-retries.js';
import { preflight } from './plan/preflight.js';
import { devCommandFrom } from './detect/dev-script.js';
import { restartHint, COMMUNITY_HINT, FEEDBACK_HINT } from './diagnose/closing-hint.js';
import { projectIdOf, rememberProjectOnDisk } from './project/remember-project.js';
import type { PackageManager } from './detect/detect.js';
import { initWithoutPackageJson } from './no-package-json.js';
import { sdkPackagesDeclared, sdkPackagesPresent } from './sdk-packages.js';
import { wasMcpRegistered } from './register/mcp-registered.js';
import { PACKAGE_JSON } from './detect/workspace-apps.js';
import { redirectToWorkspaceApp } from './detect/workspace-redirect.js';
import { appsAt, enclosingWorkspaceRoot } from './detect/workspace-apps.js';
import { isConnectStep } from './plan/connect-steps.js';
import { formatGeneratedSource } from './patch/format-generated.js';
import {
  DEPS_TARGET,
  RETICLE_CONFIG_FILE,
  MCP_TARGET,
  buildPlan,
  StepStatus,
  type Plan,
} from './plan/plan.js';
import { InitFailure } from './diagnose/init-failure.js';
import type { InitOutcome } from '@reticlehq/core/telemetry';
import { resolveLockfiles } from './detect/lockfiles.js';
import { agentRootOf, gatherPlanInput } from './gather-plan-input.js';
export type { InitOptions, InitIo, InitResult } from './run-types.js';

// Re-exported: it moved to its own module, and every existing importer says `run.js`.
export { resolveLockfiles };

/**
 * `⚠` means WORK LEFT TO DO and nothing else — it is what an agent (and the release gate) counts to
 * decide whether the install finished. A notice gets its own mark so "steps remaining" can reach zero
 * on a working install that happens to be on an ungated stack.
 */
/**
 * A step's status AFTER the run, which is what actually happened to it.
 *
 * `report` applies the same downgrade when printing: a step that failed or was skipped is shown as
 * MANUAL whatever it planned to be. Reading the planned status alone would say a step applied when
 * the run had already given up on it.
 */
function resolvedStatus(
  plan: { steps: readonly { target: string; status: StepStatus }[] },
  target: string,
  failed: ReadonlySet<string>,
  skipped: ReadonlySet<string>,
): StepStatus | undefined {
  const step = plan.steps.find((s) => s.target === target);
  if (step === undefined) return undefined;
  if (failed.has(target) || skipped.has(target)) return StepStatus.MANUAL;
  return step.status;
}

/** Every client registration row is titled `MCP server (<client>)`; the closing hint names the unfinished ones. */
const MCP_CLIENT_TITLE_PREFIX = 'MCP server (';

const STATUS_SYMBOL: Record<StepStatus, string> = {
  [StepStatus.APPLY]: '✓',
  [StepStatus.MANUAL]: '⚠',
  [StepStatus.ALREADY]: '·',
  [StepStatus.SKIP]: '–',
  [StepStatus.NOTICE]: 'ℹ',
};

/** Where workspace tooling conventionally puts packages. */
/** pnpm's workspace declaration, read when present — it is authoritative about where packages live. */

const SKIPPED_DETAIL =
  'skipped — the dependency install above failed, and wiring the app to a package that is not ' +
  'installed stops it booting. Run that install, then re-run `reticle init`.';

function report(
  plan: Plan,
  dryRun: boolean,
  failed: ReadonlySet<string>,
  skipped: ReadonlySet<string>,
  degraded: ReadonlyMap<string, string>,
  why: ReadonlyMap<string, string>,
  io: InitIo,
  projectDir: string,
  agentRoot: string | undefined,
  /** The project's own dev command, so the closing line names what a human would type. */
  devCommand: string | undefined,
  /**
   * Whether this run continues into the phases that boot the app and drive it.
   *
   * The closing hint tells the reader to restart their dev server and then drive a flow. When those
   * are the very next things this command does, printing them is worse than noise: it is an
   * instruction to do by hand what is about to happen automatically, three lines before it happens.
   */
  continuesToRuntime = false,
): InitResult {
  io.print(dryRun ? 'reticle init (dry run, no files written)' : 'reticle init');
  /*
   * The escape hatches, named by the command that needs them, at the moment it needs them.
   *
   * `--dry-run`, `--app` and `--no-mcp` all exist and all work, and they were discoverable only
   * from `--help`. A prospective user's agent refused to run this at all — correctly, since it was
   * being asked to let a third-party package edit a build config and register itself with every
   * agent on the machine, and nothing it could see offered a way to look first. It had already
   * decided by the time `--help` would have told it.
   *
   * On the REAL run only. In a dry run the reader has already found the flag.
   */
  if (!dryRun) {
    io.print(
      '  --dry-run previews · --app <dir> picks the app · --no-mcp skips agent registration',
    );
  }
  // Every path below is printed RELATIVE, and until now nothing said what to. Reported from the
  // field as "[✓] Reticle config → .reticle.json" followed by the file not being there: the app was
  // in `frontend/`, init redirected into it, and the report's `.reticle.json` was true about a
  // directory the reader was not standing in. One line makes every path in the report unambiguous.
  io.print(`  in ${projectDir}`);
  // The agent files go where the AGENT is, which after a redirect is not where the app is. Said out
  // loud because it changes where `/reticle` will exist, and a reader who assumes one directory for
  // everything goes looking in the wrong one (#318).
  if (agentRoot !== undefined)
    io.print(`  agent files in ${agentRoot} (where /reticle will exist)`);
  io.print('');
  let applied = 0;
  let manual = 0;
  // A ⚠ on a CONNECT step is a guaranteed failure, not a caveat: nothing performs the manual step, so
  // the app never dials the daemon and every tool answers "no browser session connected". `ok` was
  // hardcoded true, so a run that could not possibly work reported success.
  let connectPending = false;
  // Other clients' registrations the run left for the reader, named for the closing hint.
  const manualClients: string[] = [];
  for (const s of plan.steps) {
    // A side effect that failed to apply is reported as a manual step with its fallback command.
    const note = degraded.get(s.target);
    if (note !== undefined) {
      // Applied, but not the way it was asked for. A NOTICE, not work — the install did happen.
      io.print(`  [${STATUS_SYMBOL[StepStatus.NOTICE]}] ${s.title} → ${s.target}`);
      for (const line of note.split('\n')) io.print(`      ${line}`);
      applied++;
      continue;
    }
    const downgraded = failed.has(s.target) || skipped.has(s.target);
    const status = downgraded ? StepStatus.MANUAL : s.status;
    const detail = skipped.has(s.target)
      ? SKIPPED_DETAIL
      : downgraded && s.exec !== undefined
        ? (why.get(s.target) ?? `step failed — run manually: ${s.exec.fallback}`)
        : s.detail;
    io.print(`  [${STATUS_SYMBOL[status]}] ${s.title} → ${s.target}`);
    if (status === StepStatus.APPLY) applied++;
    if (status === StepStatus.MANUAL || status === StepStatus.NOTICE) {
      // A notice prints in full like a manual step — it is worth reading — but is NOT counted as work.
      if (status === StepStatus.MANUAL) {
        manual++;
        if (isConnectStep(s.title)) connectPending = true;
        if (s.target !== MCP_TARGET && s.title.startsWith(MCP_CLIENT_TITLE_PREFIX)) {
          manualClients.push(s.title);
        }
      }
      for (const line of detail.split('\n')) io.print(`      ${line}`);
    }
    // Everything else gets its row and nothing more. The detail on a step that needs no decision
    // restates its own title — "reticle already registered with Cursor" under
    // `[·] MCP server (Cursor)` — and a measured Vite first run spent twelve of its forty-six lines
    // that way, six tool names deep, before saying anything about the reader's own app.
    //
    // The ROW stays on every step: `apps/e2e/install-gate.mjs` reads `[mark] title → target` out of
    // this report and diffs the shape against a recorded baseline, so a row that stopped printing
    // would take that guard down with it while looking like tidying.
  }
  io.print('');
  if (connectPending) {
    io.print(
      'This app will NOT connect until the ⚠ step above is done by hand — Reticle tools will report ' +
        '"no browser session connected" until then. Everything else is already in place.',
    );
    io.print('');
  }
  const mcpStatus = resolvedStatus(plan, MCP_TARGET, failed, skipped);
  if (!continuesToRuntime) {
    io.print(restartHint(mcpStatus, devCommand, manualClients));
  }
  // Carried out even when the hint above was printed, because the RUNTIME path needs the same fact
  // and could not reach it: `restartHint` is only printed when this run stops at the files, and the
  // full run -- the one the installer sends everybody to -- ended by telling an agent to call
  // `reticle_act_and_wait` in a session whose tool list was read before Reticle existed.
  return {
    ok: !connectPending,
    applied,
    manual,
    ...(StepStatus.APPLY === mcpStatus ? { mcpNewlyRegistered: true } : {}),
  };
}

/**
 * Perform the apply-step side effects; return the targets whose side effect failed.
 *
 * Steps run in plan order, which puts the dependency install BEFORE everything that imports what it
 * installs. If it fails, the wiring is skipped rather than applied: patching `next.config.ts` to
 * import a `@reticlehq/next` that was never installed takes the dev server down with
 * MODULE_NOT_FOUND, so the app stops booting *because* Reticle was installed. A skipped step is a
 * message; a half-wired app is a broken project.
 */
function applyEffects(plan: Plan, io: InitIo, packageManager: PackageManager): Effects {
  const why = new Map<string, string>();
  const failed = new Set<string>();
  const skipped = new Set<string>();
  const degraded = new Map<string, string>();
  let installFailed = false;
  for (const s of plan.steps) {
    if (s.status !== StepStatus.APPLY) continue;
    if (installFailed && true === s.dependsOnInstall) {
      skipped.add(s.target);
      continue;
    }
    const write = s.write;
    if (write !== undefined) {
      // Confirm the EFFECT, not the intention. Reported from the field (#160): init printed
      // `[✓] Reticle config → .reticle.json` and the file was not there afterward. Nothing checked —
      // no arrangement of the filesystem (a read-only mount, a full disk, an antivirus quarantining
      // a new dotfile) could have turned that tick into anything else. A checkmark that cannot fail
      // is decoration, and this one is the first thing a new user reads. Same shape as #139.
      const wrote = io.host.span('init.write', { target: s.target, path: write.path }, () => {
        try {
          // Format connect modules with the project's Prettier when present (#684) — a clean
          // install must not fail the project's own lint on a file we just wrote.
          const content = formatGeneratedSource(write.content, write.path, io.cwd());
          io.writeFile(write.path, content);
        } catch {
          return false; // a throw is the loud version of the same failure
        }
        if (!io.exists(write.path)) return false;
        // A PATCH is only applied if what it was supposed to add is there to read back. A generated
        // file we own is proved by existing; a config we edited is not, and a patcher that quietly
        // no-ops returns the source unchanged, which writes and exists exactly like a success.
        const expect = write.expect;
        if (undefined === expect) return true;
        const after = io.readFile(write.path) ?? '';
        return expect.every((needle) => after.includes(needle));
      });
      if (!wrote) {
        failed.add(s.target);
        continue; // do not run this step's exec against a file that is not there
      }
    }
    // Bound once so the traced call cannot need a `?? ''` fallback — a default there would turn a
    // narrowing mistake into an empty command that silently "succeeds".
    const exec = s.exec;
    // Per-step, because the interesting part of init's wall-clock is WHICH step spent it: a
    // package-manager install and a `claude mcp add` are both subprocesses, and one of them being
    // slow is a completely different problem from the other.
    if (
      exec !== undefined &&
      !io.host.span('init.exec', { target: s.target, command: exec.command }, () =>
        io.exec(exec.command, exec.args),
      )
    ) {
      // A weaker second attempt beats no install at all — but only when it is REPORTED, because the
      // thing it gives up is the version pin that keeps SDK and daemon in step.
      //
      // Traced separately, and it is the reason init can take twice as long as it looks like it
      // should: this is a SECOND full package-manager run, and until it had its own span 1.6 of
      // init's 2.3 seconds simply vanished — the span above accounted for the first attempt and
      // nothing accounted for this one.
      // Walked in order, cheapest concession first, and STOPS at the first success — a later,
      // weaker attempt must never run once an earlier one has already produced a working tree.
      const succeeded = (s.retries ?? []).find((retry) =>
        io.host.span('init.exec.retry', { target: s.target, command: retry.command }, () =>
          io.exec(retry.command, retry.args),
        ),
      );
      if (succeeded !== undefined) {
        degraded.set(s.target, succeeded.note);
        continue;
      }
      // Verify, don't re-run: give the install step itself the same sdkPackagesPresent benefit
      // already given to the wiring it gates below (#683) — but only when package.json DECLARES
      // them. Reported from a Tauri + Next app: `pnpm add` died on ERR_PNPM_UNEXPECTED_STORE, the
      // packages happened to resolve, init printed success, and the manifest never gained them.
      const present =
        s.target === DEPS_TARGET && sdkPackagesPresent(plan.framework, plan.uiLibrary, io);
      if (present && sdkPackagesDeclared(plan.framework, plan.uiLibrary, io)) continue;
      failed.add(s.target);
      // A failed install only blocks the wiring when the packages are genuinely ABSENT. See
      // sdkPackagesPresent: the guard protects "the import resolves", not "our subprocess exited 0".
      if (s.target === DEPS_TARGET) {
        installFailed = !present;
        const explained = explainInstallFailure(io, packageManager, exec, s.detail);
        if (explained !== undefined) why.set(s.target, explained);
      }
    }
  }
  // Where this project lives, remembered for a daemon that will be started somewhere else.
  //
  // Deliberately AFTER the loop and unconditional on which steps ran: most init runs report "already
  // wired", and a re-run in a re-cloned or moved checkout is exactly when the remembered path has
  // gone stale — so the run that would otherwise be a no-op is the one that repairs the entry. The
  // return value is ignored on purpose; this is a cache, and a read-only home directory must not
  // turn a wired project into a failed init.
  const projectId = projectIdOf(io.readFile(RETICLE_CONFIG_FILE));
  if (projectId !== undefined) {
    rememberProjectOnDisk(io, projectId, io.cwd(), Date.now());
  }
  return { failed, skipped, degraded, why };
}

/** What applying the plan did, per step target. `why` carries a failure's real cause when known. */
interface Effects {
  failed: Set<string>;
  skipped: Set<string>;
  degraded: Map<string, string>;
  why: Map<string, string>;
}

/**
 * Which STEP failed, from the step targets — not from an error string, which would carry paths.
 *
 * The distinction that matters: a dependency install failing is a machine/network problem (offline,
 * a locked registry, a broken package manager), while MCP registration failing means the `claude` CLI
 * is missing or refused. Two completely different fixes, and until now both were simply "init didn't
 * work" with nothing to tell them apart.
 */
function classifyInitFailure(failed: ReadonlySet<string>): string {
  if (failed.has(DEPS_TARGET)) return InitFailure.DEPENDENCY_INSTALL;
  if (failed.has(MCP_TARGET)) return InitFailure.MCP_REGISTRATION;
  return InitFailure.OTHER;
}

/**
 * Where the agent stands when `init` runs inside a workspace package: the workspace root.
 *
 * The same answer `--app` from the root already gives (see enterApp), so both routes into one app
 * leave the root in one state — a pointer config and the agent files an agent opened there reads.
 */
function withWorkspaceRoot(options: InitOptions, io: InitIo): InitOptions {
  if (options.agentRoot !== undefined || true === options.redirected) return options;
  const root = enclosingWorkspaceRoot(options.cwd, io);
  if (root === undefined) return options;
  return { ...options, agentRoot: root, severalApps: 1 < appsAt(root, io).length };
}

export function runInit(options: InitOptions, io: InitIo): InitResult {
  const result = runInitSteps(withWorkspaceRoot(options, io), io);
  // The ask goes here, not in report(): report() is only the success-shaped path, and the exits that
  // matter most are the ones that never reach it — no package.json, an ambiguous workspace — where
  // setup died before anything ran and the person holding the report has the least to go on. This
  // wrapper is the one point every exit passes through.
  //
  // `redirected` is what keeps it to ONE print: wiring an app in a monorepo re-enters runInit for the
  // chosen directory, and the inner call must not ask again.
  //
  // And not when the runtime follows: it asks once it has finished, as the last thing printed,
  // rather than here in the middle, before the dev server has even started.
  if (true !== options.redirected && true !== options.continuesToRuntime) {
    io.print('');
    io.print(FEEDBACK_HINT);
    if (result.ok && true !== options.dryRun) {
      io.print(COMMUNITY_HINT);
    }
  }
  return result;
}

/**
 * The manifest, parsed once, or the reason it could not be.
 *
 * It used to be parsed in three places from the same raw string, and two of them were unguarded —
 * so `reticle init` on a `package.json` with a trailing comma died with a raw `SyntaxError` and a
 * stack through `redirectToWorkspaceApp`. A stack trace in front of a user is a bug whatever caused
 * it, and this one lands on the very first thing the command does, before it has said anything.
 *
 * `setup/reticle.mjs` has always got this right ("… is not valid JSON (…). Fix it and re-run"). The
 * shipped CLI did not, which is the shape of every divergence between the two: the prototype refuses
 * politely, `init` throws. Parsing once at the single point the file enters means no later caller
 * CAN reintroduce it — a guard per call site would have been three guards and a fourth one waiting.
 */
function readManifest(io: InitIo): { pkg: unknown } | { error: string } {
  const raw = io.readFile(PACKAGE_JSON);
  if (null === raw) return { pkg: null };
  try {
    return { pkg: JSON.parse(raw) };
  } catch (err) {
    // First line only: JSON.parse's message carries the offending position, and the rest is noise.
    const detail = String(err instanceof Error ? err.message : err).split('\n')[0] ?? 'unparseable';
    return { error: detail };
  }
}

function runInitSteps(options: InitOptions, io: InitIo): InitResult {
  const manifest = readManifest(io);
  if ('error' in manifest) {
    io.print(
      `${PACKAGE_JSON} is not valid JSON (${manifest.error}). Fix it and re-run — init reads the ` +
        'framework, the dev script and the package manager from it, and will not guess at any of ' +
        'them from a file it cannot read.',
    );
    if (!options.dryRun)
      io.host.reportOutcome({ ok: false, reason: InitFailure.MALFORMED_PACKAGE_JSON });
    return { ok: false, applied: 0, manual: 0 };
  }
  const pkgRaw = manifest.pkg;
  // Look for the app BEFORE concluding there isn't one.
  //
  // A root with no package.json is not a dead end — it is the ordinary shape of a repo whose app
  // lives one directory down (`frontend/`, `web/`, `client/`) with no manifest at the top. Bailing
  // first made that repo un-instrumentable: `reticle init` said "No package.json found", and
  // `--app frontend`, the flag that exists for exactly this, was never read because the bail came
  // first. Reported twice by the same user, who tried the documented workaround and hit the same
  // wall. Discovery already handles the case (it scans top-level directories, not just declared
  // workspaces); it was simply unreachable. `'{}'`: a directory with no manifest is not the app.
  const redirectedEarly = redirectToWorkspaceApp(options, io, pkgRaw ?? {}, runInit);
  // Listing the apps below still counts as "no app here", in the same series as before.
  if (true === redirectedEarly?.listedAppsBelow && !options.dryRun)
    io.host.reportOutcome({ ok: false, reason: InitFailure.NO_PACKAGE_JSON });
  if (redirectedEarly !== null) return redirectedEarly;
  if (null === pkgRaw) return initWithoutPackageJson(options, io);

  // Init is the flow a user experiences the wait of personally, and the fixture gate measures it at
  // 1–6s per app with no explanation of the spread. These three spans split that number into detect
  // (filesystem probing), plan (pure), and apply (writes + package-manager and CLI subprocesses).
  const planInput = gatherPlanInput(options, io, pkgRaw);

  // Before anything is written, and AFTER detection — the package manager to check is the one init
  // RESOLVED, not a raw lockfile read. An inherited pnpm-lock.yaml at a monorepo root does not mean
  // the app in frontend/ uses pnpm, and checking the file refused a scaffold the install gate proves
  // must succeed. Both conditions make every later phase fail, and each arrives far from its cause
  // when it is not checked here. See preflight.ts.
  const preflightIo = {
    cwd: () => io.cwd(),
    canWrite: () => io.canWrite(),
    probe: (command: string, args: readonly string[]) => io.probe(command, args),
  };
  const resolved = preflight(preflightIo, planInput.detection.packageManager, {
    alreadyServed: options.url !== undefined && '' !== options.url,
  });
  if (resolved.refusal !== undefined) {
    io.print(resolved.refusal);
    if (!options.dryRun) io.host.reportOutcome({ ok: false, reason: InitFailure.PREFLIGHT });
    return { ok: false, applied: 0, manual: 1 };
  }
  // The prefix that can actually run it on THIS machine — `pnpm`, or `corepack pnpm` where preflight
  // just proved only corepack can. Threaded onto detection (never recomputed by `detect`, which is
  // pure and never probes) so the install step, its retries and the dev command all spawn and print
  // the same thing preflight just confirmed works, instead of a bare binary it already ruled out.
  const packageManagerCommand = resolved.command;
  planInput.detection = { ...planInput.detection, packageManagerCommand };
  const plan = io.host.span('init.plan', {}, () => buildPlan(planInput));
  const effects = options.dryRun
    ? { failed: new Set<string>(), skipped: new Set<string>(), degraded: new Map(), why: new Map() }
    : io.host.span('init.apply', { steps: plan.steps.length }, () =>
        applyEffects(plan, io, planInput.detection.packageManager),
      );
  const { failed, skipped, degraded, why } = effects;
  // The project's own dev command, so the closing line names what a human would actually type.
  const devCommand = devCommandFrom(pkgRaw, packageManagerCommand);
  const result = report(
    plan,
    options.dryRun,
    failed,
    skipped,
    degraded,
    why,
    io,
    options.cwd,
    agentRootOf(options),
    devCommand,
    true === options.continuesToRuntime,
  );
  // A dry run is a preview, not an outcome — reporting it would inflate both success and failure.
  if (options.dryRun) return result;
  const outcome: InitOutcome = {
    ok: result.ok,
    ...(result.ok ? {} : { reason: classifyInitFailure(failed) }),
    stack: plan.framework,
    // The step's REAL final status, not the absence of a failure — see mcp-registered.
    mcpRegistered: wasMcpRegistered(resolvedStatus(plan, MCP_TARGET, failed, skipped)),
  };
  const context: InitContext = {
    appDir: options.cwd,
    framework: plan.framework,
    packageManager: planInput.detection.packageManager,
    ...(undefined === devCommand ? {} : { devCommand }),
    ...(true === options.redirected ? { redirectedTo: options.cwd } : {}),
  };
  /*
   * The two INSTALL steps `init` is the only thing that can answer.
   *
   * `mcp_registered` reads the step's REAL resolved status rather than "nothing failed" — the same
   * distinction `mcpRegistered` above already makes, and for the same reason: a step that was
   * SKIPPED never registered anything, and reporting it as success is how a funnel shows an install
   * completing that never gave the agent any tools.
   *
   * `instrumented` is FILES WRITTEN and nothing more. The page still has to load and dial the
   * bridge, which `app_connected` reports minutes later from the daemon — keeping them separate is
   * the whole reason this funnel exists.
   */
  /*
   * REPORTED HERE, not where detection happens, and the reason is a measured one.
   *
   * These are fire-and-forget POSTs. Emitted mid-run, `project_detected` never arrived: the CLI
   * exited before the request landed, exactly as `daemon_stopped` once did microseconds before
   * `process.exit(0)` — the failure the telemetry contract opens with. The steps below survive
   * because init keeps working after them, so the request has time to complete.
   *
   * Grouping them is a workaround and worth naming as one: the real fix is a flush before exit, and
   * until there is one, ANY emit that is not followed by work is a coin toss. Nothing fails loudly
   * when it loses; the data is just quietly absent.
   */
  io.host.reportStep({
    phase: OnboardingPhase.FIRST_RUN,
    step: 'project_detected',
    status: OnboardingStepStatus.COMPLETED,
    stack: planInput.detection.framework,
  });
  const mcpOk = wasMcpRegistered(resolvedStatus(plan, MCP_TARGET, failed, skipped));
  io.host.reportStep({
    phase: OnboardingPhase.INSTALL,
    step: 'agents_detected',
    status: OnboardingStepStatus.COMPLETED,
    stack: plan.framework,
  });
  io.host.reportStep({
    phase: OnboardingPhase.INSTALL,
    step: 'mcp_registered',
    status: mcpOk ? OnboardingStepStatus.COMPLETED : OnboardingStepStatus.SKIPPED,
    stack: plan.framework,
  });
  io.host.reportStep({
    phase: OnboardingPhase.FIRST_RUN,
    step: 'instrumented',
    status: result.ok ? OnboardingStepStatus.COMPLETED : OnboardingStepStatus.FAILED,
    stack: plan.framework,
    ...(result.ok ? {} : { reason: classifyInitFailure(failed) }),
  });
  // A failed dependency install skipped every wiring step, so there is no instrumented app to boot:
  // without a context the runtime stops at this report, rather than starting the dev server and
  // diagnosing an SDK that was never installed as a dev server that needs restarting.
  const handover = failed.has(DEPS_TARGET) ? {} : { context };
  if (true === options.deferOutcome) return { ...result, ...handover, outcome };
  io.host.reportOutcome(outcome);
  return { ...result, ...handover };
}
