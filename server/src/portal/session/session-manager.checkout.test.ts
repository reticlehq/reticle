import { describe, expect, it } from 'vitest';
import type { Checkout } from '@reticlehq/core';
import { scopeToCallerCheckout } from './session-manager.js';

const GIT = '/repo/.git';
const MAIN: Checkout = {
  root: '/repo',
  mainRoot: '/repo',
  commonDir: GIT,
  branch: 'main',
  linked: false,
};
const WT_A: Checkout = {
  root: '/wt/a',
  mainRoot: '/repo',
  commonDir: GIT,
  branch: 'feat/a',
  linked: true,
};
const WT_B: Checkout = {
  root: '/wt/b',
  mainRoot: '/repo',
  commonDir: GIT,
  branch: 'feat/b',
  linked: true,
};

const tab = (id: string, url: string) => ({ id, url });
const servedBy: Record<string, Checkout> = {
  'http://localhost:5173/': MAIN,
  'http://localhost:5174/': WT_A,
  'http://localhost:5175/': WT_B,
};
const checkoutOfTab = (t: { url: string }): Checkout | undefined => servedBy[t.url];

describe('scopeToCallerCheckout', () => {
  /** Two agents, two worktrees, one app: each must land on its own tab, never the other's. */
  it('keeps only the tabs served from the agent’s own worktree', () => {
    const tabs = [tab('s-main', 'http://localhost:5173/'), tab('s-a', 'http://localhost:5174/')];
    expect(scopeToCallerCheckout(tabs, WT_A, checkoutOfTab).sessions.map((s) => s.id)).toEqual([
      's-a',
    ]);
    expect(scopeToCallerCheckout(tabs, MAIN, checkoutOfTab).sessions.map((s) => s.id)).toEqual([
      's-main',
    ]);
  });

  /** The tab of another worktree runs other code: a verdict on it is about code the agent never touched. */
  it('refuses when every tab is served from another worktree, and names them', () => {
    const result = scopeToCallerCheckout(
      [tab('s-b', 'http://localhost:5175/')],
      WT_A,
      checkoutOfTab,
    );
    expect(result.sessions).toEqual([]);
    expect(result.refusal).toContain('/wt/b');
    expect(result.refusal).toContain('feat/b');
    expect(result.refusal).toContain('s-b');
    expect(result.refusal).toContain('/wt/a');
  });

  /**
   * A tab nothing can place (no announcing plugin, no `lsof`) may be the agent's own. A tab known to
   * come from another worktree never is: keeping it let freshness pick it over the unknown one.
   */
  it('drops the tabs of other worktrees and keeps the ones it cannot place', () => {
    const tabs = [tab('s-b', 'http://localhost:5175/'), tab('s-x', 'http://localhost:9999/')];
    expect(scopeToCallerCheckout(tabs, WT_A, checkoutOfTab)).toEqual({ sessions: [tabs[1]] });
  });

  /** A bare clone has no main checkout, so its worktrees differ in mainRoot and share commonDir. */
  it('scopes the worktrees of a bare repository', () => {
    const bareA: Checkout = {
      root: '/wt/a',
      mainRoot: '/wt/a',
      commonDir: '/app.git',
      linked: true,
    };
    const bareB: Checkout = {
      root: '/wt/b',
      mainRoot: '/wt/b',
      commonDir: '/app.git',
      linked: true,
    };
    const tabA = tab('s-a', 'a');
    const tabB = tab('s-b', 'b');
    const of = (t: { url: string }) => ('a' === t.url ? bareA : bareB);
    expect(scopeToCallerCheckout([tabA, tabB], bareA, of).sessions).toEqual([tabA]);
    expect(scopeToCallerCheckout([tabB], bareA, of).refusal).toContain('/wt/b');
  });

  /*
   * #1916. Claude Code starts the MCP server in the folder it was opened in, the main checkout, and
   * then moves the agent into `.claude/worktrees/<name>`. The proxy folder is then not where the agent
   * works, and every call was refused although the agent drove the tab of its own worktree.
   */
  it('drives the one linked worktree that serves every tab when the proxy runs in the main checkout', () => {
    const tabs = [tab('s-b', 'http://localhost:5175/')];
    expect(scopeToCallerCheckout(tabs, MAIN, checkoutOfTab)).toEqual({ sessions: tabs });
  });

  it('still refuses when tabs of more than one linked worktree are open and the proxy runs in the main checkout', () => {
    const tabs = [tab('s-a', 'http://localhost:5174/'), tab('s-b', 'http://localhost:5175/')];
    const result = scopeToCallerCheckout(tabs, MAIN, checkoutOfTab);
    expect(result.sessions).toEqual([]);
    expect(result.refusal).toContain('/wt/a');
    expect(result.refusal).toContain('/wt/b');
  });

  it('keeps every tab when the agent is outside git', () => {
    const tabs = [tab('s-b', 'http://localhost:5175/')];
    expect(scopeToCallerCheckout(tabs, undefined, checkoutOfTab)).toEqual({ sessions: tabs });
  });

  it('keeps every tab of a different repository', () => {
    const other: Checkout = {
      root: '/elsewhere',
      mainRoot: '/elsewhere',
      commonDir: '/elsewhere/.git',
      linked: false,
    };
    const tabs = [tab('s-b', 'http://localhost:5175/')];
    expect(scopeToCallerCheckout(tabs, other, checkoutOfTab)).toEqual({ sessions: tabs });
  });

  /** The proxy reads `c:\\…` from its shell. Vite announces `C:/…`. Git writes the gitdir as `C:/…`. */
  it('keeps the agent’s own tab on Windows when the case and separators differ', () => {
    const wtA = (root: string, commonDir: string): Checkout => ({
      root,
      mainRoot: 'C:/repo',
      commonDir,
      linked: true,
    });
    const tabs = [tab('s-a', 'http://localhost:5174/'), tab('s-b', 'http://localhost:5175/')];
    const served: Record<string, Checkout> = {
      'http://localhost:5174/': wtA('C:/wt/a', 'C:/repo/.git'),
      'http://localhost:5175/': wtA('C:/wt/b', 'C:/repo/.git'),
    };
    const caller = wtA('c:\\wt\\a', 'C:\\repo\\.git');
    expect(scopeToCallerCheckout(tabs, caller, (t) => served[t.url])).toEqual({
      sessions: [tabs[0]],
    });
  });
});
