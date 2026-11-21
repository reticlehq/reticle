import { describe, expect, it } from 'vitest';

import { attachPlan, electronWarning, pickApp } from './attach.js';

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
      electronSwitch: false,
    });
  });

  it('takes the token and the port from the environment first', () => {
    const env = { RETICLE_TOKEN: 'tok-env', RETICLE_PORT: '4411' };
    const plan = attachPlan(['--app', 'Notes'], env, '/home', read);
    expect(plan).toMatchObject({ url: 'ws://localhost:4411/reticle', token: 'tok-env', watch: [] });
  });

  it('says what is missing when no application is named', () => {
    expect(attachPlan([], {}, '/home', read)).toEqual({
      error: 'Name the application: --app <name>.',
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
    expect(electronWarning(program, off, electron)).toMatch(/--electron-switch/);
    expect(electronWarning(program, { ...off, electronSwitch: true }, electron)).toBeUndefined();
    expect(electronWarning(program, off, () => false)).toBeUndefined();
    expect(electronWarning('/usr/bin/tool', off, electron)).toBeUndefined();
  });

  it('reads the switch for Electron from the arguments', () => {
    const read = () => undefined;
    const on = attachPlan(['--app', 'Notes', '--electron-switch'], {}, '/home', read);
    const off = attachPlan(['--app', 'Notes'], {}, '/home', read);
    expect(on).toMatchObject({ electronSwitch: true });
    expect(off).toMatchObject({ electronSwitch: false });
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
