/**
 * The version-skew remedies, which used to be two hardcoded strings (#618).
 *
 * `sdkFix` named `@reticlehq/react`, so a Nuxt/Vue project was told to install a React package it
 * must not have. `DAEMON_FIX` said `reticle stop` unconditionally, which cannot converge the pair
 * when the daemon is the newer half.
 */
import { describe, expect, it } from 'vitest';
import { daemonFix, sdkFix } from './version-skew.js';

describe('the daemon remedy branches on which half is behind', () => {
  it('asks for `reticle stop` when the daemon is the older half', () => {
    expect(daemonFix('2.3.0', '2.4.1')).not.toContain('will not converge');
    expect(daemonFix('2.3.0', '2.4.1')).toMatch(/Run `reticle stop`/);
  });

  it('does NOT ask for `reticle stop` when the daemon is newer — it cannot converge', () => {
    // The reported case: the MCP registration is unpinned and resolves fresh, so the agent's
    // server is routinely behind a long-lived daemon. Stopping it starts another newer daemon.
    const fix = daemonFix('2.5.0', '2.4.1');
    // It still NAMES `reticle stop` — to say it does not work here.
    expect(fix).toContain('will not converge');
    expect(fix).not.toMatch(/Run `reticle stop`/);
    expect(fix).toContain('restart the agent');
  });

  it('falls back to the restart-the-daemon advice when a version cannot be compared', () => {
    expect(daemonFix(undefined, '2.4.1')).toMatch(/Run `reticle stop`/);
    expect(daemonFix('2.4.1', undefined)).toMatch(/Run `reticle stop`/);
    expect(daemonFix('not-a-version', '2.4.1')).toMatch(/Run `reticle stop`/);
  });

  it('treats equal versions as no direction, so it does not invent the harder advice', () => {
    expect(daemonFix('2.4.1', '2.4.1')).toMatch(/Run `reticle stop`/);
  });

  it('compares numerically, not lexically', () => {
    // '2.10.0' < '2.9.0' as strings; the daemon here is genuinely newer.
    expect(daemonFix('2.10.0', '2.9.0')).toContain('will not converge');
  });
});

/**
 * The restart advice ignored the pages (#1709).
 *
 * An agent newer than the daemon was told to run `reticle stop`. When every connected page runs
 * the daemon's SDK version, that restart replaces one mismatch with a wider one: the new daemon
 * and every page. The SDK update is the step that puts all three on one version.
 */
describe('daemon advice looks at the connected pages before it says to restart (#1709)', () => {
  it('pages on the daemon version: update the SDK, and do not restart', () => {
    const fix = daemonFix('2.3.0', '2.4.1', ['2.3.0', '2.3.0']);
    expect(fix).not.toMatch(/Run `reticle stop`/);
    expect(fix).toContain('skews every page');
    expect(fix).toContain('@reticlehq/browser@2.4.1');
    expect(fix).toContain('pages, the daemon and the agent');
  });

  it('pages on the agent version: keep the restart', () => {
    const fix = daemonFix('2.3.0', '2.4.1', ['2.4.1', '2.4.1']);
    expect(fix).toMatch(/Run `reticle stop`/);
    expect(fix).not.toContain('skews every page');
  });

  it('no pages: keep the restart', () => {
    expect(daemonFix('2.3.0', '2.4.1', [])).toMatch(/Run `reticle stop`/);
    expect(daemonFix('2.3.0', '2.4.1')).toMatch(/Run `reticle stop`/);
  });

  it('keeps the restart when a page did not report the daemon version', () => {
    expect(daemonFix('2.3.0', '2.4.1', ['2.3.0', undefined])).toMatch(/Run `reticle stop`/);
  });

  it('does not let matching pages override a daemon that is already newer', () => {
    const fix = daemonFix('2.5.0', '2.4.1', ['2.5.0']);
    expect(fix).toContain('will not converge');
    expect(fix).not.toMatch(/Run `reticle stop`/);
  });
});

describe('the SDK remedy does not name a package the project must not have', () => {
  it('names the framework-neutral sensor, not the React kit', () => {
    // The remedy has no project context, so it must name the package that is never actively
    // wrong: @reticlehq/browser works in a React app, the reverse does not hold.
    const fix = sdkFix('2.4.1');
    expect(fix).not.toContain('@reticlehq/react');
    expect(fix).toContain('@reticlehq/browser@2.4.1');
  });

  it('says the dev server must restart, so a stale pre-bundle is not read as a fixed upgrade', () => {
    expect(sdkFix('2.4.1')).toContain('restart');
  });
});

/**
 * The MCP server starts the daemon. When the pages are newer than the MCP server, `reticle stop`
 * only starts the same old daemon again, and the advice loops.
 */
describe('daemon advice names the MCP server when the pages are newer than it', () => {
  it('same daemon and agent version, newer pages: update the MCP server, do not stop', () => {
    const fix = daemonFix('3.2.0', '3.2.0', ['3.7.0']);
    expect(fix).not.toMatch(/Run `reticle stop`/);
    expect(fix).toContain("agent's MCP server is 3.2.0");
    expect(fix).toContain('3.7.0');
    expect(fix).toContain('plugin');
  });

  it('daemon older than an agent that is still older than the pages: update the MCP server', () => {
    const fix = daemonFix('3.2.0', '3.5.0', ['3.7.0']);
    expect(fix).not.toMatch(/Run `reticle stop`/);
    expect(fix).toContain("agent's MCP server is 3.5.0");
  });

  it('pages not newer than the agent: keep the earlier advice', () => {
    expect(daemonFix('3.2.0', '3.7.0', ['3.7.0'])).toMatch(/Run `reticle stop`/);
    expect(daemonFix('3.2.0', '3.2.0', ['3.2.0'])).toMatch(/Run `reticle stop`/);
  });
});
