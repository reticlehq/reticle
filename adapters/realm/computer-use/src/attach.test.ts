import { describe, expect, it } from 'vitest';

import {
  attachPlan,
  electronWarning,
  isElectron,
  joinedAnswer,
  pickApp,
  withOwnerLimits,
} from './attach.js';

const files: Record<string, string> = {
  '/home/.reticle/pairing-token': 'tok-file\n',
  '/code/notes/.reticle.json': '{ "framework": "appkit", "projectId": "notes-1a2b" }',
  '/code/empty/.reticle.json': '{}',
};
const read = (path: string): string | undefined => files[path];

describe('attachPlan', () => {
  it('reads the application, the port and the folders, and finds the token of the bridge', () => {
    const plan = attachPlan(
      ['--app', 'Notes', '--port', '14400', '--watch', '/out'],
      {},
      '/home',
      read,
    );
    expect(plan).toEqual({
      app: 'Notes',
      url: 'ws://localhost:14400/reticle',
      token: 'tok-file',
      watch: ['/out'],
      electronSwitch: true,
      foreground: true,
      hud: true,
      open: false,
    });
  });

  it('starts an application that is not open only when the caller says --open', () => {
    expect(attachPlan(['--app', 'Notes'], {}, '/home', read)).toMatchObject({ open: false });
    expect(attachPlan(['--app', 'Notes', '--open'], {}, '/home', read)).toMatchObject({
      open: true,
    });
  });

  it('takes the token and the port from the environment first', () => {
    const env = { RETICLE_TOKEN: 'tok-env', RETICLE_PORT: '4411' };
    const plan = attachPlan(['--app', 'Notes'], env, '/home', read);
    expect(plan).toMatchObject({ url: 'ws://localhost:4411/reticle', token: 'tok-env', watch: [] });
  });

  it('says what is missing when no application is named', () => {
    expect(attachPlan([], {}, '/home', read)).toEqual({
      error: 'Name the application: --app <name>. To see the names that are open: --list.',
    });
  });

  it('ties the application to the project of a folder, and says so when the folder has none', () => {
    const tied = attachPlan(['--app', 'Notes', '--project', '/code/notes'], {}, '/home', read);
    expect(tied).toMatchObject({ projectId: 'notes-1a2b' });

    // No folder named: no project. The caller is told what that means, not given a made-up id.
    expect(attachPlan(['--app', 'Notes'], {}, '/home', read)).not.toHaveProperty('projectId');

    for (const folder of ['/code/empty', '/code/nowhere']) {
      const refused = attachPlan(['--app', 'Notes', '--project', folder], {}, '/home', read);
      expect(refused).toHaveProperty('error');
      expect(JSON.stringify(refused)).toContain('reticle init');
    }
  });

  /**
   * An Electron application gave its elements, answered "done" to a press, and did nothing.
   * The person must hear that before the first press, not find it from actions with no effect.
   */
  it('warns for an Electron application that is joined with its switch off', () => {
    const program = '/Applications/Notes.app/Contents/MacOS/Notes';
    const electron = (path: string) =>
      '/Applications/Notes.app/Contents/Frameworks/Electron Framework.framework' === path;
    const off = { app: 'Notes', electronSwitch: false };
    expect(electronWarning(program, off, electron)).toMatch(/--no-electron-switch/);
    expect(electronWarning(program, { ...off, electronSwitch: true }, electron)).toBeUndefined();
    expect(electronWarning(program, off, () => false)).toBeUndefined();
    expect(electronWarning('/usr/bin/tool', off, electron)).toBeUndefined();
  });

  // Chrome has no Electron in it, so the join set no switch, and a press on a page of Chrome was
  // answered with "done" and never reached the page.
  it('takes a Chromium browser for an application that needs the switch', () => {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const frameworks = (path: string) =>
      '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework' ===
      path;
    expect(isElectron(chrome, frameworks)).toBe(true);
    expect(isElectron('/Applications/Notes.app/Contents/MacOS/Notes', frameworks)).toBe(false);
  });

  it('shows the pointer and the window of the realm unless the person says not to', () => {
    const read = () => undefined;
    expect(attachPlan(['--app', 'Notes'], {}, '/home', read)).toMatchObject({ hud: true });
    expect(attachPlan(['--app', 'Notes', '--no-hud'], {}, '/home', read)).toMatchObject({
      hud: false,
    });
  });

  it('lets a person keep the pointer: no foreground with --background-only', () => {
    const read = () => undefined;
    expect(attachPlan(['--app', 'Notes'], {}, '/home', read)).toMatchObject({ foreground: true });
    expect(attachPlan(['--app', 'Notes', '--background-only'], {}, '/home', read)).toMatchObject({
      foreground: false,
    });
  });

  // An agent that joins an Electron application must not have to know about the switch.
  it('sets the switch for Electron unless the person says not to', () => {
    const read = () => undefined;
    const on = attachPlan(['--app', 'Notes'], {}, '/home', read);
    const off = attachPlan(['--app', 'Notes', '--no-electron-switch'], {}, '/home', read);
    expect(on).toMatchObject({ electronSwitch: true });
    expect(off).toMatchObject({ electronSwitch: false });
  });

  /**
   * The command took the project of the folder it ran in, to spare an agent the sessionId. A
   * browser tab of that project then shared its scope with the application, and a call for the
   * page could go to the application. A desktop application is in a project only when the
   * person names the folder.
   */
  it('is in no project unless a folder is named', () => {
    const read = (path: string) =>
      '/work/app/.reticle.json' === path ? '{"projectId":"app-1"}' : undefined;
    expect(attachPlan(['--app', 'Notes'], {}, '/home', read)).not.toHaveProperty('projectId');
    expect(
      attachPlan(['--app', 'Notes', '--project', '/work/app'], {}, '/home', read),
    ).toMatchObject({ projectId: 'app-1' });
  });

  it('says what to call next, and gives the sessionId only when a call needs it', () => {
    const inProject = joinedAnswer(
      { app: 'Notes', projectId: 'app-1', foreground: true },
      'cu-Notes-7',
      7,
    );
    expect(inProject).toMatchObject({
      joined: true,
      sessionId: 'cu-Notes-7',
      needsSessionId: false,
    });
    expect(JSON.stringify(inProject['next'])).not.toContain('sessionId:');
    const alone = joinedAnswer({ app: 'Notes', foreground: true }, 'cu-Notes-7', 7);
    expect(alone['needsSessionId']).toBe(true);
    expect(JSON.stringify(alone['next'])).toContain('sessionId: \\"cu-Notes-7\\"');
  });

  // An application that was started behind a full-screen Space has its window on another Space.
  // The join said "joined", and the first look gave a tree with nothing to act on.
  it('says that the window cannot be read when it is on another Space, and what brings it', () => {
    const away = joinedAnswer({ app: 'Notes', foreground: true }, 'cu-Notes-7', 7, {
      windows: 0,
      windowsNotOnScreen: 1,
    });
    expect(away['readable']).toBe(false);
    expect(String(away['why'])).toContain('another Space');
    expect(String(away['why'])).toContain('foreground: true');
    const kept = joinedAnswer({ app: 'Notes', foreground: false }, 'cu-Notes-7', 7, {
      windows: 0,
      windowsNotOnScreen: 1,
    });
    expect(String(kept['why'])).not.toContain('foreground: true');
    const here = joinedAnswer({ app: 'Notes', foreground: true }, 'cu-Notes-7', 7, {
      windows: 1,
      windowsNotOnScreen: 1,
    });
    expect(here).not.toHaveProperty('readable');
  });
});

/**
 * The command found an application by the name of its process only. "Visual Studio Code" runs as
 * "Code", so the name a person sees found nothing, and the refusal did not say what was open.
 */
describe('pickApp', () => {
  const running = [
    { name: 'Visual Studio Code', process: 'Code', pid: 11 },
    { name: 'Notes', process: 'Notes', pid: 12 },
    { name: 'Notes Helper', process: 'NotesHelper', pid: 13 },
  ];

  it('finds an application by the name a person sees, and by the name of its process', () => {
    expect(pickApp('Visual Studio Code', running)).toEqual({ pid: 11 });
    expect(pickApp('Code', running)).toEqual({ pid: 11 });
    expect(pickApp('notes', running)).toEqual({ pid: 12 });
  });

  // Two with one name: the command joined the first in the list, which was one that was ending.
  it('takes the one that was started last, of several with the same name', () => {
    const two = [
      { name: 'Notes', process: 'Notes', pid: 20, launched: 100 },
      { name: 'Notes', process: 'Notes', pid: 21, launched: 200 },
    ];
    expect(pickApp('Notes', two)).toEqual({ pid: 21 });
  });

  it('names what is near, when the name fits nothing exactly', () => {
    expect(pickApp('Studio', running)).toEqual({
      error: 'No application named Studio is open. Did you mean: Visual Studio Code?',
    });
  });

  // The list began with the Dock and the wallpaper, and the twelve names had no real application.
  it('names the applications with a window in the Dock before the helpers of the system', () => {
    const mixed = [
      { name: 'Dock', process: 'Dock', pid: 1, regular: false },
      { name: 'Notes', process: 'Notes', pid: 2, regular: true },
    ];
    expect(pickApp('Mail', mixed)).toEqual({
      error: 'No application named Mail is open. These are open: Notes, Dock.',
    });
  });

  it('names what is open, when nothing is near', () => {
    expect(pickApp('Mail', running)).toEqual({
      error:
        'No application named Mail is open. These are open: Visual Studio Code, Notes, Notes Helper.',
    });
  });
});

/**
 * An agent starts the command, so an agent picks its flags: it could leave out the window of the
 * realm, or allow itself the real pointer, and it could join again after the person pressed Stop.
 * The limits of the person are in a file of their own, and a flag does not lift them.
 */
describe('withOwnerLimits', () => {
  const plan = (argv: string[]) => {
    const made = attachPlan(['--app', 'Notes', ...argv], {}, '/home', () => undefined);
    if ('error' in made) {
      throw new Error(made.error);
    }
    return made;
  };
  const stopped = '/home/.reticle/computer-use.stopped';

  it('forbids the real pointer when the person said so, whatever the flags', () => {
    expect(withOwnerLimits(plan([]), '{"backgroundOnly":true}', undefined, stopped)).toMatchObject({
      foreground: false,
    });
    expect(withOwnerLimits(plan([]), undefined, undefined, stopped)).toMatchObject({
      foreground: true,
    });
  });

  it('keeps the window of the realm on the screen when the person said so', () => {
    expect(withOwnerLimits(plan(['--no-hud']), '{"hud":true}', undefined, stopped)).toMatchObject({
      hud: true,
    });
    expect(withOwnerLimits(plan(['--no-hud']), '{}', undefined, stopped)).toMatchObject({
      hud: false,
    });
  });

  it('joins nothing after Stop, until the person removes the file', () => {
    const refused = withOwnerLimits(plan([]), undefined, '2026-11-21 12:00', stopped);
    expect(refused).toEqual({ error: expect.stringContaining(stopped) as unknown });
    expect(refused).toEqual({ error: expect.stringContaining('Do not remove it') as unknown });
  });

  it('reads a broken file as no limits, and does not stop the command', () => {
    expect(withOwnerLimits(plan([]), '{not json', undefined, stopped)).toMatchObject({
      foreground: true,
    });
  });
});
