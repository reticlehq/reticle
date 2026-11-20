/**
 * What must be true before `reticle-computer-use` can join an application, and the exact thing
 * to do for each one that is not. Pure: the command gathers the facts, and a test gives its own.
 *
 * The first run is where a person gives up. Each line here is one check, and a line that is not
 * `ok` says what to do, not only what is wrong.
 */
export interface DoctorFacts {
  platform: string;
  /** The Swift compiler is there to build the helper. */
  compiler: boolean;
  /** The terminal has Accessibility permission. Absent: it was not asked. */
  trusted?: boolean | undefined;
  app: string;
  appOpen: boolean;
  /** Windows of the application on this screen. Absent: they were not read. */
  windows?: number | undefined;
  windowsNotOnScreen?: number | undefined;
  /** The bridge of the daemon answers. */
  bridge: boolean;
  /** A pairing token for the bridge was found. */
  token: boolean;
}

export interface DoctorReport {
  ready: boolean;
  lines: string[];
}

const OK = 'ok   ';
const FIX = 'FIX  ';

export function doctorReport(facts: DoctorFacts): DoctorReport {
  const lines: string[] = [];
  const stop = (line: string): DoctorReport => ({
    ready: false,
    lines: [...lines, `${FIX}${line}`],
  });

  if ('darwin' !== facts.platform) {
    return stop(`reticle-computer-use runs on macOS only. This is ${facts.platform}.`);
  }
  lines.push(`${OK}macOS`);
  if (!facts.compiler) {
    return stop(
      'The helper is built on this machine and needs the Swift compiler. Run: xcode-select --install',
    );
  }
  lines.push(`${OK}the Swift compiler is here`);
  if (false === facts.trusted) {
    return stop(
      'The terminal has no Accessibility permission. Open System Settings, Privacy & Security, Accessibility, and switch on the terminal you use. Then start the terminal again.',
    );
  }
  lines.push(`${OK}Accessibility permission`);
  if (!facts.appOpen) {
    return stop(
      `No application named ${facts.app} is open. Open ${facts.app}, or give its exact name with --app.`,
    );
  }
  if (0 === (facts.windows ?? 0)) {
    const elsewhere = facts.windowsNotOnScreen ?? 0;
    return stop(
      elsewhere > 0
        ? `${facts.app} has ${String(elsewhere)} window(s) on another Space or made small. Only the Space in front can be read. Bring ${facts.app} to this Space.`
        : `${facts.app} has no window. Open a window in it.`,
    );
  }
  lines.push(`${OK}${facts.app} is open, with ${String(facts.windows)} window(s) on this screen`);
  if (!facts.bridge) {
    return stop(
      facts.token
        ? 'The Reticle daemon does not answer. Start it with: reticle serve'
        : 'The Reticle daemon does not answer, and no pairing token was found. Start it with: reticle serve',
    );
  }
  lines.push(`${OK}the Reticle daemon answers`);
  return { ready: true, lines };
}
