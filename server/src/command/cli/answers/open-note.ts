import { ReticleTool } from '@reticlehq/core';
import { NoSessionReason } from '@reticlehq/core/telemetry';

const LeaseAction = { ACQUIRE: 'acquire' } as const;

const LeaseArgument = {
  TOOL: 'tool',
  ARGS: 'args',
  ACTION: 'action',
  URL: 'url',
} as const;

const OpenLaunchFailureCopy = {
  NOTHING_OPENED: 'Nothing was opened.',
  OS_BROWSER: 'This command asks the OS to open a url in your default browser',
  LAUNCH_FAILED: (launcher: string) => `(\`${launcher}\` on this platform) and that failed,`,
  OPEN_MANUALLY: 'so open the url yourself or set a default browser.',
  RETICLE_BROWSER: 'If you are using Reticle tools, open it in a Reticle-owned browser with',
} as const;

/**
 * What `reticle open` says when it launched a URL and no session appeared.
 *
 * `open` resolves the port leniently on purpose: if nothing is on the port you asked for, it finds a
 * running daemon instead, so nobody has to hunt for the port. That is the right default and it has
 * one sharp edge — when it substitutes, the command is now talking to a DIFFERENT daemon than the
 * caller named, and every subsequent sentence is about that other daemon.
 *
 * Observed driving this repo's own fixture: `open --port 4470` found nothing there, silently used a
 * daemon on 4400, and reported that the app "carries no Reticle SDK, or dials a port other than
 * 4400". The app was wired and was dialling 4470 exactly as asked. Reticle knew both numbers and
 * reported neither, so the one actionable fact — you are pointed at the wrong daemon — was the only
 * thing missing, and the advice given instead was to re-run `init` on a correctly installed app.
 *
 * That is the same shape as the field reports where a daemon in the wrong repo produced a diagnosis
 * blaming the app: an absence explained by a cause the daemon had already ruled out.
 *
 * So the substitution is stated FIRST, with both numbers, before any cause that assumes they match.
 */
export function openFailureNote(
  port: number,
  requestedPort: number,
  daemon: DaemonNoSessionAnswer = {},
  /** The url `open` launched. A refusal counts only when its page is on the same origin. */
  openedUrl?: string,
): string {
  const refusal = refusalFrom(daemon, openedUrl);
  const substituted =
    port === requestedPort
      ? ''
      : `NOTE FIRST: you asked for port ${String(requestedPort)} and nothing was listening there, ` +
        `so this used a daemon already running on ${String(port)}. If your app dials ` +
        `${String(requestedPort)}, that is the whole problem — nothing below applies. Start a daemon ` +
        `on ${String(requestedPort)} (\`npx @reticlehq/server serve --port ${String(requestedPort)}\`) ` +
        `or point the app at ${String(port)}. `;
  const handedOver =
    `${substituted}the URL was handed to the system default browser (this command does not use ` +
    `Reticle's own Chromium, so a chromium warning from \`reticle doctor\` is unrelated ` +
    `to this). No Reticle session appeared.`;
  if (refusal !== undefined) {
    return `${handedOver} ${OpenRefusalCopy.NOT_THE_SDK} ${refusal}`;
  }
  return (
    `${handedOver} By far the likeliest cause is that the app ` +
    `carries no Reticle SDK, or dials a port other than ${String(port)} — run ` +
    `\`npx @reticlehq/server init\` in the app's directory and restart its dev server. If the app IS ` +
    `wired, give the page a moment and check the browser console: the SDK announces its ` +
    `own connect failures there, including the one it refuses to make from a ` +
    `non-localhost host, which needs BOTH allowNonLocalhost: true AND a pairing token ` +
    `(~/.reticle/pairing-token) — the flag alone is not sufficient.`
  );
}

/** What the daemon's `/status` said about its empty bridge, as `summarizeStatus` reads it. */
export interface DaemonNoSessionAnswer {
  whyReason?: string;
  whyLead?: string;
  why?: string;
  refusedUrl?: string;
}

const OpenRefusalCopy = {
  NOT_THE_SDK:
    'The SDK is not missing: a page dialled this daemon and the daemon refused it. The daemon says:',
} as const;

/**
 * The daemon's own account of the page it refused, or undefined when that page is not this one.
 *
 * A refused hello is positive evidence that the SDK is in the page. Reported from the field: a
 * window the agent had detached reloaded, the bridge refused it, and `open` said the SDK was
 * missing (#2435). The bridge records the refusal, so `open` reads that before it guesses.
 *
 * The refusal is daemon-wide. It can be another app's tab, and that tab says nothing about the SDK
 * in this app. So the refusal counts only when its page has the origin of the url `open` launched.
 * An unknown page or url falls back to the SDK advice.
 */
function refusalFrom(
  daemon: DaemonNoSessionAnswer,
  openedUrl: string | undefined,
): string | undefined {
  if (daemon.whyReason !== NoSessionReason.AUTH_REFUSED) {
    return undefined;
  }
  const refused = originOf(daemon.refusedUrl);
  if (refused === undefined || refused !== originOf(openedUrl)) {
    return undefined;
  }
  return daemon.whyLead ?? daemon.why;
}

const OPAQUE_ORIGIN = 'null';

/** The origin of a url, or undefined when there is none, it does not parse, or it is opaque. */
function originOf(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  try {
    const { origin } = new URL(url);
    // An opaque origin (`file:`, `data:`) is the string "null", and two of them are not one page.
    return OPAQUE_ORIGIN === origin ? undefined : origin;
  } catch {
    return undefined;
  }
}

/** Recovery when the OS could not open a URL: agents can use Reticle's browser lease instead. */
export function openLaunchFailureNote(url: string, launcher: string): string {
  return (
    `${OpenLaunchFailureCopy.NOTHING_OPENED} ${OpenLaunchFailureCopy.OS_BROWSER} ` +
    `${OpenLaunchFailureCopy.LAUNCH_FAILED(launcher)} ${OpenLaunchFailureCopy.OPEN_MANUALLY} ` +
    `${OpenLaunchFailureCopy.RETICLE_BROWSER} ` +
    `\`${ReticleTool.RUN} { ${LeaseArgument.TOOL}: "${ReticleTool.LEASE}", ${LeaseArgument.ARGS}: { ${LeaseArgument.ACTION}: "${LeaseAction.ACQUIRE}", ${LeaseArgument.URL}: ${JSON.stringify(url)} } }\`.`
  );
}
