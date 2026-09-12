import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { PlatformProfile, RETICLE_IPC_GLOBAL, ReticleCommand } from '@reticlehq/core';
import { declaredCommands, declaredPlatform, SERVED_COMMANDS } from './declared-platform.js';

/**
 * The declaration has to match what this build actually does.
 *
 * A hand-written list of served commands is a list that goes stale, and it goes stale silently in
 * the direction that hurts: a command added to the dispatcher and not to the list is declared
 * unavailable, so no decider ever asks for it, so nobody notices it was implemented. The reverse
 * is worse — a command declared and not handled is a promise the page breaks after an action has
 * been spent reaching for it.
 *
 * So this reads the dispatcher's source and compares. Source-matching is a blunt instrument and
 * this repository has been bitten by a guard that passed on a COMMENT quoting the code it
 * replaced, so the comparison is against the dispatched names only, taken from the same enum both
 * sides use rather than from a string.
 */

// Resolved from the package root rather than from `import.meta.url`: this suite runs in a DOM
// environment, where the module url is an http: one and `readFileSync` refuses it.
/**
 * Every command name this SDK's source mentions, read from the whole package.
 *
 * The first version of this read `reticle.ts` alone and found seven, because the dispatcher
 * delegates: most commands are handled in the module that owns them and only named there. A scan
 * of one file would have declared this build unable to do most of what it does.
 *
 * Read from the SOURCE and matched against the enum both sides already use, rather than against
 * string literals — a guard in this repository once went green because a comment quoted the code
 * it replaced, and matching on `ReticleCommand.KEY` at least requires the symbol to be present.
 */
function knownCommands(): string[] {
  const source = execFileSync('git', ['grep', '-rhoE', 'ReticleCommand\\.[A-Z_]+', '--', 'src'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  const keys = new Set(
    source.split('\n').map((line) => line.trim().replace('ReticleCommand.', '')),
  );
  return Object.entries(ReticleCommand)
    .filter(([key]) => keys.has(key))
    .map(([, value]) => value);
}

describe('what this build says it will answer', () => {
  it('declares every command this build knows about', () => {
    const undeclared = knownCommands().filter((name) => !SERVED_COMMANDS.includes(name));
    expect(
      undeclared,
      'These are handled and not declared, so no decider will ever ask for them and nobody will ' +
        'notice they were implemented.',
    ).toEqual([]);
  });

  it('declares nothing this build has never heard of', () => {
    // The more expensive direction: a promise the page breaks after an action was spent reaching
    // for it. Weaker than it looks -- a name the source mentions is not proof it is handled -- so
    // this catches a typo and a deletion, and not a command that was gutted while keeping its
    // constant. The e2e tool-surface sweep is what covers that, by asking a live page.
    const unknown = SERVED_COMMANDS.filter((name) => !knownCommands().includes(name));
    expect(unknown, 'These are declared and this build never mentions them.').toEqual([]);
  });

  it('finds commands at all, so the scan cannot pass by matching nothing', () => {
    expect(knownCommands().length).toBeGreaterThan(10);
  });

  it('hands out a copy, so nobody can edit what this build claims about itself', () => {
    const first = declaredCommands();
    first.push('not_a_command');
    expect(declaredCommands()).not.toContain('not_a_command');
  });
});

describe('what kind of place this is', () => {
  it('is web in an ordinary page', () => {
    expect(declaredPlatform()).toBe(PlatformProfile.WEB);
  });

  it('is webview when a desktop shell installed its channel', () => {
    // Declaring `web` for a Tauri or Electron window sends a reader advice about browser tabs and
    // dev servers to somebody who has neither, which is worse than declaring nothing.
    const global = window as unknown as Record<string, unknown>;
    global[RETICLE_IPC_GLOBAL] = { invoke: () => undefined };
    try {
      expect(declaredPlatform()).toBe(PlatformProfile.WEBVIEW);
    } finally {
      delete global[RETICLE_IPC_GLOBAL];
    }
  });

  it('is webview inside Tauri, which installs no preload channel', () => {
    const global = window as unknown as Record<string, unknown>;
    global['__TAURI_INTERNALS__'] = { invoke: () => undefined };
    try {
      expect(declaredPlatform()).toBe(PlatformProfile.WEBVIEW);
    } finally {
      delete global['__TAURI_INTERNALS__'];
    }
  });
});
