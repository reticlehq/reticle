/**
 * Make ready the tab a platform drive runs in, as its spec asks, and say what was and was not done.
 *
 * The person's own tab, or one opened for the drive: headless, or in a window they can watch. Then
 * the HUD as asked. Every step that cannot be done is reported, never thrown: a drive asked for a
 * window on a machine with no display still runs headless if that is all there is, and says so.
 */
import {
  DriveMode,
  DriveTarget,
  HudVisibility,
  SpecIgnoredReason,
  type DriveApplied,
  type DriveSpec,
  type SpecIgnored,
} from '@reticlehq/core';

/** How many times the HUD is asked for before giving up: a page's HUD mounts after it connects. */
export const HUD_ATTEMPTS = 4;
export const HUD_RETRY_MS = 500;

/** What a refused drive is told when no address was given to open. */
export const NO_ADDRESS_TO_OPEN =
  'Nothing says where this app runs, so no browser could be opened for it. Open the app once with Reticle running, or give the drive an address.';

export interface DriveTargetPorts {
  /** The person's own tab for the drive, as the chat already picks it. Null: none may be driven. */
  pickTab: () => Promise<string | null | undefined>;
  /** Open `url` in a browser of the daemon's own; answers the tab's session id. Throws why not. */
  open: (url: string, headed: boolean, hud: HudVisibility | undefined) => Promise<string>;
  /** Ask the page for this HUD; throws when the page did not take it (no HUD yet, an older SDK). */
  tuneHud: (sessionId: string, hud: HudVisibility) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

export interface PreparedDrive {
  sessionId: string | null | undefined;
  applied: DriveApplied;
  ignored: SpecIgnored[];
  /** Why the drive cannot run, in a person's words, when it cannot. */
  refusal?: string;
}

export async function prepareDrive(
  spec: DriveSpec,
  fallbackUrl: string | undefined,
  ports: DriveTargetPorts,
): Promise<PreparedDrive> {
  const mode = spec.mode ?? DriveMode.LOCAL;
  const ignored: SpecIgnored[] = [];
  let target = spec.target ?? DriveTarget.TAB;
  let sessionId: string | null | undefined;
  let url: string | undefined;
  if (DriveTarget.TAB !== target) {
    url = spec.url ?? fallbackUrl;
    if (url === undefined)
      return {
        sessionId: null,
        applied: { target, mode },
        ignored,
        refusal: NO_ADDRESS_TO_OPEN,
      };
    try {
      sessionId = await ports.open(url, DriveTarget.HEADED === target, spec.hud);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // A window that cannot open falls back to a browser with none: the drive still runs.
      if (DriveTarget.HEADED !== target)
        return { sessionId: null, applied: { target, mode, url }, ignored, refusal: detail };
      ignored.push({ field: 'target', reason: SpecIgnoredReason.UNAVAILABLE, detail });
      target = DriveTarget.HEADLESS;
      try {
        sessionId = await ports.open(url, false, spec.hud);
      } catch (again) {
        const why = again instanceof Error ? again.message : String(again);
        return { sessionId: null, applied: { target, mode, url }, ignored, refusal: why };
      }
    }
  } else {
    sessionId = await ports.pickTab();
  }
  const applied: DriveApplied = {
    target,
    mode,
    ...(url === undefined ? {} : { url }),
    ...('string' === typeof sessionId ? { sessionId } : {}),
  };
  if (spec.hud !== undefined && 'string' === typeof sessionId) {
    const taken = await tune(ports, sessionId, spec.hud);
    if (taken === undefined) applied.hud = spec.hud;
    else ignored.push({ field: 'hud', reason: SpecIgnoredReason.UNAVAILABLE, detail: taken });
  }
  return { sessionId, applied, ignored };
}

/** Ask for the HUD until the page takes it; answers why not when it never does. */
async function tune(
  ports: DriveTargetPorts,
  sessionId: string,
  hud: HudVisibility,
): Promise<string | undefined> {
  let why = 'the page did not take it';
  for (let attempt = 1; attempt <= HUD_ATTEMPTS; attempt += 1) {
    try {
      await ports.tuneHud(sessionId, hud);
      return undefined;
    } catch (error) {
      why = error instanceof Error ? error.message : String(error);
      if (attempt < HUD_ATTEMPTS) await ports.sleep(HUD_RETRY_MS);
    }
  }
  return why;
}
