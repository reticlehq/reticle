/**
 * What `init` does after the files are written, and how it decides whether to.
 *
 * Lives here rather than in cli.ts because it is a cohesive unit with its own reasons, and because
 * cli.ts is a dispatcher: a command that grew a second half should not make the file that routes
 * every command harder to read.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InitConfirmation, RETICLE_DEFAULT_PORT } from '@reticlehq/core';
import { FEEDBACK_HINT, Framework, InitFailure, type InitResult } from '@reticlehq/init';
import { confirmInstall, nodeConfirmDeps } from '@/command/setup/terminal/confirm.js';
import { writeLicenseKey } from '@/command/setup/license-key.js';
import {
  registerOtherAgents,
  runSetupCommand,
  type FirstFlowPort,
} from '@/command/setup/setup-command.js';
import { bridgeOccupied } from '@/command/setup/bringup/bridge-port.js';
import {
  defaultPairingTokenDir,
  readOrCreatePairingTokenSync,
} from '@/portal/bridge/pairing-token.js';
import { relaunchDecision } from '@/command/setup/bringup/relaunch.js';
import { claudeTranscriptExists, codexSessionFor } from '@/command/setup/terminal/transcripts.js';
import { probePresence } from '@/command/daemon/binding/port-presence.js';
import { probeDaemon } from '@/surface/mcp/proxy/proxy-daemon-probe.js';
import { fetchStatus } from '@/command/daemon/binding/daemon-status-probe.js';
import { collectEnv, DEFAULT_PHASE_TIMEOUT_MS } from '@/command/setup/setup-options.js';
import { staticPageDevCommand } from '@/command/setup/bringup/static-page-server.js';
import { SetupPhase } from '@/command/setup/run-setup.js';
import { reportInitOutcome } from '@/telemetry/init-telemetry.js';

/** How often the runtime phases look again: fast enough not to be the wait, slow enough to be free. */
const POLL_MS = 250;

/**
 * The shapes whose served HTML carries the SDK marker: Vite injects it into index.html, and a plain
 * HTML page has the snippet pasted in. Everything else connects from the JS bundle, where a fetch
 * of the document can never see it. See `htmlCarriesSdk` in run-setup.ts.
 */
const HTML_CARRIES_SDK: ReadonlySet<string> = new Set([Framework.VITE, Framework.HTML]);

/** The connect component `init` writes for a Next App Router project. */
const NEXT_APP_CONNECT = ['app', 'src/app'].flatMap((d) =>
  ['tsx', 'jsx', 'js'].map((ext) => `${d}/reticle-dev.${ext}`),
);

/**
 * Does the served document name the SDK, so its absence means a stale dev server?
 *
 * A Next App Router page names its client components in the flight data inlined into the HTML —
 * `reticle-dev.tsx`, measured on Next 16 under Turbopack and webpack alike. Reported from a Next app
 * whose dev server was already running before init: setup waited on a page that could never connect
 * and said nothing, because Next was assumed to carry the SDK only in its bundle. The Pages Router
 * names chunks, not modules, so it stays silent.
 */
export function htmlCarriesSdk(framework: string, exists: (path: string) => boolean): boolean {
  if (HTML_CARRIES_SDK.has(framework)) return true;
  return Framework.NEXT === framework && NEXT_APP_CONNECT.some(exists);
}

/** Just enough of the parsed command to decide and run. */
interface InitRuntimeArgs {
  readonly port: number | undefined;
  readonly dryRun: boolean;
  readonly filesOnly?: boolean | undefined;
  readonly json?: boolean | undefined;
  /** `--no-first-run` sets it false: connect, and stop without the coverage summary. */
  readonly firstRun?: boolean | undefined;
  readonly open?: boolean | undefined;
  readonly agents?: boolean | undefined;
  /**
   * `--no-mcp`. It governs agent registration too, and pre-approval with it.
   *
   * The flag's own help says it skips MORE than the server registration, "because all three only
   * make sense once the tools are reachable" — and a pre-approval rule for a server the machine was
   * told not to register is the clearest case of that. It went unread when the registration moved
   * here, so a run that asked us to leave the machine's config alone wrote to four files in the
   * user's home. The install gate caught it, because the gate runs with --no-mcp.
   */
  readonly mcp?: boolean | undefined;
  readonly env?: string[] | undefined;
  readonly url?: string | undefined;
  readonly timeoutSeconds?: number | undefined;
  /** Restart the calling client so IT gets the tools — see relaunch.ts. */
  readonly relaunch?: boolean | undefined;
  readonly licenseKey?: string | undefined;
}

/** Registration is global MCP wiring, so both flags that disown it are read here. */
function wantsAgents(parsed: InitRuntimeArgs): boolean {
  return false !== parsed.agents && false !== parsed.mcp;
}

interface RuntimePrintIo {
  readonly print: (line: string) => void;
}

const licenseIo = {
  exists: (path: string): boolean => existsSync(path),
  readFile: (path: string): string => readFileSync(path, 'utf8'),
  writeFile: (path: string, contents: string): void => writeFileSync(path, contents),
};

/**
 * Carry on from a finished `init`, or stop where it used to.
 *
 * `--files-only` is what init did before it learned to boot the app, and a dry run is a preview:
 * both keep the old ending. Everyone else gets the rest, because writing files was never the same
 * thing as an install working.
 */
function printRelaunch(parsed: InitRuntimeArgs, io: RuntimePrintIo, cwd: string): void {
  if (true !== parsed.relaunch) return;
  io.print(
    relaunchDecision({
      ...(undefined === process.env['CLAUDE_CODE_SESSION_ID']
        ? {}
        : { claudeSessionId: process.env['CLAUDE_CODE_SESSION_ID'] }),
      ...(undefined === codexSessionFor(cwd) ? {} : { codexSessionId: codexSessionFor(cwd) }),
      transcriptExists: claudeTranscriptExists,
      cwd,
    }).message,
  );
  io.print('');
}

export async function continueAfterInit(
  parsed: InitRuntimeArgs,
  result: InitResult,
  io: RuntimePrintIo,
  cwd: string,
  /** init's ending once the connection is proved: coverage and the agent prompt. See `FirstFlowPort`. */
  firstFlow?: FirstFlowPort,
): Promise<void> {
  const port = parsed.port ?? RETICLE_DEFAULT_PORT;

  // Real installs persist the key whichever way setup ends. A preview must leave .env and
  // .gitignore untouched, just as it leaves project wiring and agent configuration untouched.
  if (!parsed.dryRun && undefined !== parsed.licenseKey) {
    const written = writeLicenseKey(cwd, parsed.licenseKey, licenseIo);
    io.print(written.message);
  }

  // Decided and printed before the `--files-only` return, not after it. The restart question is
  // asked by whoever just installed, and `--files-only` is the mode an agent uses when the app is
  // ALREADY running — so the one route that most needs the answer was the one route that could not
  // reach it, and `--relaunch --files-only` accepted the flag and silently did nothing with it.
  //
  // Never performed: opening a terminal is not something a one-shot command should do behind a
  // flag, and the half worth having is the refusal — `--resume` on an id with no transcript opens
  // an EMPTY conversation that looks exactly like it worked. See relaunch.ts.
  printRelaunch(parsed, io, cwd);

  if (true === parsed.filesOnly || parsed.dryRun) {
    // Registration and pre-approval still run here, and this is the ONLY route an existing user
    // has: nothing reaches back into a machine that installed Reticle a version ago, so the
    // upgrade path is re-running init, and the light form of init has to be enough to carry it.
    // A dry run writes nothing anywhere, including here.
    if (!parsed.dryRun && true === parsed.filesOnly && wantsAgents(parsed)) {
      registerOtherAgents(io.print);
    }
    return confirmInstall(result, io, nodeConfirmDeps(port)).then(() => {
      if (true === parsed.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.ok) process.exit(1);
    });
  }

  // From here on init left the ask to us, so it is the last thing on every exit below.
  const ask = (spaced = true): void => {
    if (spaced) io.print('');
    io.print(FEEDBACK_HINT);
  };
  const context = result.context;
  if (context === undefined) {
    // Nothing was established, so there is nothing to run against. init has already said why.
    ask();
    if (true === parsed.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(1);
  }
  const reportFailure = (reason: InitFailure): void => {
    if (result.outcome !== undefined) {
      reportInitOutcome({ ...result.outcome, ok: false, reason });
    }
  };
  // A PENDING connect step is not a reason to skip the runtime phase, and treating it as one made
  // `init` stop with "paste this snippet" while never looking at the app.
  //
  // `result.ok` is exactly `!connectPending`, so every project whose instrumentation needs a manual
  // step — a plain-HTML app, anything with no recognised build config — exited here. The user was
  // told to do something by hand and told nothing about whether their server was even up, whether
  // the snippet had landed, or which url was checked. The runtime phase answers all three, and its
  // answers are the actionable ones: "nothing is serving http://…", "the SDK is NOT in the page".
  //
  // The run still ends non-zero: the phase returns `ok: false` when no session appears, and a
  // session appearing means the manual step WAS done and the app really did connect — which is a
  // green worth reporting, not one to suppress.

  // Before the connect wait, never after: a bridge held by a stranger makes a session impossible,
  // so going ahead spends the entire budget and then reports what reads as an instrumentation
  // problem — the one place that is fine. See bridge-port.ts.
  const refusal = bridgeOccupied(
    await probePresence(port, { tcpOpen: probeDaemon, status: fetchStatus }).catch(
      (error: unknown) => {
        reportFailure(InitFailure.RUNTIME_ERROR);
        throw error;
      },
    ),
    port,
  );
  if (refusal !== undefined) {
    reportFailure(InitFailure.BRIDGE_OCCUPIED);
    io.print(refusal);
    ask();
    if (true === parsed.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, reason: InitFailure.BRIDGE_OCCUPIED }, null, 2)}\n`,
      );
    }
    process.exit(1);
  }

  return runSetupCommand(
    {
      appDir: context.appDir,
      invokedAt: cwd,
      bridgePort: port,
      // Read here because this is the layer that already owns the bridge: setup opens a lease over
      // the daemon's MCP transport for `--no-open`, and that transport is gated on this token.
      pairingToken: readOrCreatePairingTokenSync(defaultPairingTokenDir()),
      env: collectEnv(parsed.env ?? []),
      openBrowser: false !== parsed.open,
      firstRun: false !== parsed.firstRun,
      json: true === parsed.json,
      firstFlow,
      registerAgents: wantsAgents(parsed),
      phaseTimeoutMs:
        undefined === parsed.timeoutSeconds
          ? DEFAULT_PHASE_TIMEOUT_MS
          : parsed.timeoutSeconds * 1000,
      // Only when the caller actually said so — see connectBudgetMs. Omitted, the shape's policy
      // keeps deciding, so nobody who passed nothing waits less than they used to.
      ...(undefined === parsed.timeoutSeconds
        ? {}
        : {
            connectBudgetMs: parsed.timeoutSeconds * 1000,
            startupBudgetMs: parsed.timeoutSeconds * 1000,
          }),
      pollMs: POLL_MS,
      htmlCarriesSdk: htmlCarriesSdk(context.framework, (rel) =>
        existsSync(join(context.appDir, rel)),
      ),
      // A plain page with no dev script gets Reticle's own static server, so the page is actually
      // served and the connect can be proved, instead of stopping at "start the app yourself".
      ...((): { devCommand?: string } => {
        const devCommand =
          context.devCommand ??
          (undefined === parsed.url
            ? staticPageDevCommand({
                appDir: context.appDir,
                isStaticPage: Framework.HTML === context.framework,
              })
            : undefined);
        return undefined === devCommand ? {} : { devCommand };
      })(),
      ...(undefined === parsed.url ? {} : { suppliedUrl: parsed.url }),
    },
    (line) => io.print(line),
  ).then(
    (outcome) => {
      if (result.outcome !== undefined) {
        const init = {
          ...result.outcome,
          ok: outcome.ok,
        };
        if (outcome.ok) {
          delete init.reason;
          init.confirmation = InitConfirmation.CONNECTED;
        } else {
          // A failed startup does not establish whether a daemon or instrumented page exists.
          // Keep the watcher's no_daemon/no_session/no_page classifications for observed facts.
          delete init.confirmation;
          init.reason =
            outcome.reachedPhase === SetupPhase.DEV_SERVER
              ? InitFailure.DEV_SERVER
              : InitFailure.APP_CONNECTION;
        }
        reportInitOutcome(init);
      }
      // One object, so an agent reads a result instead of interpreting a report.
      if (true === parsed.json) {
        process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
        if (!outcome.ok) process.exit(1);
        return;
      }
      io.print('');
      // The precondition for everything the closing asks for, printed on the path that could not say
      // it. An agent client reads its MCP server list when it STARTS and never re-reads it, so on the
      // run that first registers Reticle the `reticle_*` tools are not in the session that just asked
      // for them -- and this path closes by telling that session to call `reticle_act_and_wait`.
      // `restartHint` has said this for a long time and is printed only when init stops at the files.
      if (true === result.mcpNewlyRegistered) {
        io.print(
          'Reticle was registered with your agent by this run, and an agent reads its tool list only ' +
            'when it starts: the `reticle_*` tools are NOT in this session yet. Restart it first — ' +
            '`npx @reticlehq/server init --relaunch` prints the exact resume command for Claude Code ' +
            'and Codex. Once per machine.',
        );
        io.print('');
      }
      if (outcome.ok && !outcome.flowSaved) {
        // Success, and no flow. Saying "a flow was driven" here would replace a wrong exit code with
        // a wrong sentence, which is the worse of the two: the exit code is read by CI and the
        // sentence is read by a person deciding whether their app is verified. It is not.
        // The connect already said "connected, nothing verified yet" and listed what to do next;
        // repeating it here was the same sentence twice, three lines apart.
        for (const [i, step] of outcome.fallback.entries())
          io.print(`   ${String(i + 1)}. ${step}`);
        // Already spaced by the blank line above when nothing was listed.
        ask(0 < outcome.fallback.length);
        return;
      }
      if (outcome.ok) {
        io.print(
          `✓ setup complete — ${outcome.url ?? 'the app'} is instrumented and its first flow is ` +
            'saved. The tab stays open; a linked project sends the flow and its run to your dashboard.',
        );
        ask();
        return;
      }
      // A run that produced no verdict did not succeed, and the exit code is the one place a caller
      // reads that without parsing anything.
      io.print('⚠ setup did not finish. To carry on from here:');
      for (const [i, step] of outcome.fallback.entries()) io.print(`   ${i + 1}. ${step}`);
      ask();
      process.exit(1);
    },
    (error: unknown) => {
      reportFailure(InitFailure.RUNTIME_ERROR);
      throw error;
    },
  );
}
