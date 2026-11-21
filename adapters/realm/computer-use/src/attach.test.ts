import { describe, expect, it } from 'vitest';

import { attachPlan, electronWarning, joinedAnswer, pickApp } from './attach.js';

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
   * An agent had to give a sessionId on each tool call, because the session was in no project.
   * The command now takes the project of the folder it runs in, and the tools find the session.
   */
  it('takes the project of the folder it runs in, when no folder is named', () => {
    const read = (path: string) =>
      '/work/app/.reticle.json' === path ? '{"projectId":"app-1"}' : undefined;
    expect(attachPlan(['--app', 'Notes'], {}, '/home', read, '/work/app')).toMatchObject({
      projectId: 'app-1',
    });
    // A folder that is no project is not an error: the session is then in no project.
    const none = attachPlan(['--app', 'Notes'], {}, '/home', read, '/work/other');
    expect(none).not.toHaveProperty('error');
    expect(none).not.toHaveProperty('projectId');
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

  it('names what is open, when nothing is near', () => {
    expect(pickApp('Mail', running)).toEqual({
      error:
        'No application named Mail is open. These are open: Visual Studio Code, Notes, Notes Helper.',
    });
  });
});
