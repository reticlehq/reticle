/**
 * `init` should start the project's dev server itself.
 *
 * The install currently ends with "Restart `vite`." in a closing paragraph — a human action, in a
 * terminal about to be cleared by the client restart the same paragraph asks for. It is the second
 * unmarked hand-off after the capabilities file, and it lands on the same surface: prose nobody
 * re-reads.
 *
 * Everything needed to remove it is already in the project. This is the judgement half: which
 * script, and whether to touch anything at all.
 */

import { describe, expect, it } from 'vitest';
import {
  desktopLaunch,
  devCommandFrom,
  planDevScript,
  DevScriptChoice,
  workspaceDevCommand,
} from './dev-script.js';

const pm = 'pnpm';

describe('picking the script', () => {
  it('prefers `dev`', () => {
    const p = planDevScript({ dev: 'vite', start: 'node server.js' }, pm, false);
    expect(p.choice).toBe(DevScriptChoice.START);
    expect(p.script).toBe('dev');
  });

  it('falls back to `start`, then `serve`', () => {
    expect(planDevScript({ start: 'x' }, pm, false).script).toBe('start');
    expect(planDevScript({ serve: 'x' }, pm, false).script).toBe('serve');
  });

  it('says so rather than guessing when no script is recognised', () => {
    expect(planDevScript({ build: 'tsc', test: 'vitest' }, pm, false).choice).toBe(
      DevScriptChoice.NO_SCRIPT,
    );
  });

  it('ignores a script declared empty', () => {
    expect(planDevScript({ dev: '' }, pm, false).script).toBe(undefined);
  });
});

describe('the command it would print', () => {
  it('uses `npm run` for npm, which needs it', () => {
    expect(planDevScript({ dev: 'vite' }, 'npm', false).command).toBe('npm run dev');
  });

  it('uses the bare form for pnpm and yarn, which do not', () => {
    expect(planDevScript({ dev: 'vite' }, 'pnpm', false).command).toBe('pnpm dev');
    expect(planDevScript({ dev: 'vite' }, 'yarn', false).command).toBe('yarn dev');
  });
});

describe('it never starts a second server', () => {
  /**
   * The server already running may be the user's, with their state and their tabs pointed at it.
   * Starting a second one races for the port and can leave them looking at whichever won.
   */
  it('stands down when something already answers, even with a dev script present', () => {
    const p = planDevScript({ dev: 'vite' }, pm, true);
    expect(p.choice).toBe(DevScriptChoice.ALREADY_SERVING);
  });

  it('names no command when it is not going to run one', () => {
    expect(planDevScript({ dev: 'vite' }, pm, true).command).toBe(undefined);
  });
});

/**
 * A desktop shell's `dev` script is its RENDERER's dev server. On the official Tauri template `dev`
 * is plain `vite`: init ran it, no window ever opened, and the run waited out its whole budget.
 */
describe('a desktop project', () => {
  const TAURI_TEMPLATE = {
    scripts: { dev: 'vite', build: 'tsc && vite build', tauri: 'tauri' },
    devDependencies: { '@tauri-apps/cli': '^2' },
  };

  it('launches Tauri through its own script, not the renderer dev server', () => {
    expect(devCommandFrom(TAURI_TEMPLATE, 'npm')).toBe('npm run tauri dev');
    expect(devCommandFrom(TAURI_TEMPLATE, 'pnpm')).toBe('pnpm tauri dev');
  });

  it('runs the Tauri CLI directly when no script names it', () => {
    const pkg = { scripts: { dev: 'vite' }, devDependencies: { '@tauri-apps/cli': '^2' } };
    expect(devCommandFrom(pkg, 'npm')).toBe('npx tauri dev');
  });

  it('launches Electron Forge through the script that runs it', () => {
    const pkg = {
      scripts: { dev: 'vite', start: 'electron-forge start' },
      devDependencies: { '@electron-forge/cli': '^7' },
    };
    expect(devCommandFrom(pkg, 'npm')).toBe('npm run start');
  });

  it('leaves a web project on its dev script', () => {
    expect(devCommandFrom({ scripts: { dev: 'vite' } }, 'npm')).toBe('npm run dev');
    expect(desktopLaunch({ scripts: { dev: 'vite' } })).toBeUndefined();
  });
});

/**
 * Reported from the field: init in `apps/web` ran that app's own `vite`, while the root `dev`
 * script also started the API workspace. The page loaded and every `/api` call failed with
 * ECONNREFUSED, so the first verdict was about a half-started app.
 */
describe('a workspace app whose root dev script starts the whole workspace', () => {
  const app = { name: '@acme/web', dir: 'apps/web' };
  const root = (dev: string): unknown => ({ scripts: { dev } });

  it('runs the root dev script when it runs every workspace package', () => {
    expect(workspaceDevCommand(root('turbo run dev'), app, pm)).toBe('pnpm dev');
    expect(workspaceDevCommand(root('turbo dev'), app, 'npm')).toBe('npm run dev');
    expect(workspaceDevCommand(root('pnpm -r --parallel dev'), app, pm)).toBe('pnpm dev');
    expect(workspaceDevCommand(root('nx run-many -t dev'), app, pm)).toBe('pnpm dev');
  });

  it('runs it when it names this app among the ones it starts', () => {
    const both = 'concurrently "pnpm --filter @acme/web dev" "pnpm --filter @acme/api dev"';
    expect(workspaceDevCommand(root(both), app, pm)).toBe('pnpm dev');
    expect(
      workspaceDevCommand(root('turbo dev --filter=@acme/web --filter=@acme/api'), app, pm),
    ).toBe('pnpm dev');
    expect(workspaceDevCommand(root('npm-run-all -p "dev --prefix apps/web" api'), app, pm)).toBe(
      'pnpm dev',
    );
  });

  it('keeps the app script when the root filters to other packages only', () => {
    expect(workspaceDevCommand(root('turbo dev --filter=@acme/api'), app, pm)).toBeUndefined();
    expect(workspaceDevCommand(root('pnpm --filter docs dev'), app, pm)).toBeUndefined();
  });

  it('does not read a longer package name as this app', () => {
    const web = { name: 'web', dir: 'apps/web' };
    expect(workspaceDevCommand(root('pnpm --filter web-admin dev'), web, pm)).toBeUndefined();
  });

  it('keeps the app script when the root has no dev script or it starts no workspace', () => {
    expect(workspaceDevCommand({ scripts: {} }, app, pm)).toBeUndefined();
    expect(workspaceDevCommand(root('node scripts/dev.js'), app, pm)).toBeUndefined();
    expect(workspaceDevCommand(null, app, pm)).toBeUndefined();
  });
});
