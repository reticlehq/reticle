import { describe, expect, it } from 'vitest';
import { join, relative, sep } from 'node:path';
import { importsOf, reachableFrom, resolveImport } from './import-graph.js';

/**
 * The library entry point may never reach the install-time surface.
 *
 * `@reticlehq/server` has two doors: the root barrel (`index.ts`), which a consumer imports to LEASE
 * the engine — bridge, pool, tool surface, stores — and `cli.ts`, which is the `reticle` bin and owns
 * everything a human runs before their first session. The scaffolder belongs to the second door only,
 * and it is now its own package, `@reticlehq/init`.
 *
 * A consumer that embeds the engine never invokes the CLI, so the scaffolder costs it nothing —
 * provided the boundary actually holds. It did not, when the scaffolder still lived in this tree:
 * `mcp/mcp.ts` and `mcp/proxy-handshake.ts` each reached into `init/mcp.js` for the MCP server NAME,
 * a wire identity that had no business living behind the installer. One misplaced constant is all it
 * takes for the whole install-time subtree to become load-bearing on the library path, and the cost
 * of that is not measured in bytes: it is that a consumer who wants none of it now has an opinion
 * about it, and the only way to express that opinion is a fork.
 *
 * Splitting the package did not make the guard unnecessary, it changed what the guard reads: the
 * subtree is now a bare specifier rather than a directory prefix. This walks the real import graph
 * rather than trusting a grep, because the reach that matters is the transitive one — nobody adds
 * `import '@reticlehq/init'` to `index.ts`, they add it four modules down.
 *
 * Only crossings ON the library path are declared below. `telemetry/init-telemetry.ts` also
 * re-exports from the scaffolder and is deliberately absent: the barrel does not reach it, and
 * listing an unreachable module would be an exemption nobody could tell had gone stale.
 */

const SRC = join(__dirname);

/** The package that belongs to the CLI door and must stay unreachable from the library door. */
const CLI_ONLY_PACKAGE = '@reticlehq/init';

/**
 * The crossings that exist today, each with the reason it is allowed to stay.
 *
 * This does not ban crossings; it bans UNDECLARED ones. Adding a module here is the moment to ask
 * whether the thing being reached for actually belongs behind the installer — which is how the
 * `MCP_SERVER_NAME` crossing got resolved rather than listed.
 */
const DECLARED_CROSSINGS: Record<string, string> = {
  'telemetry/feedback-context.ts':
    'Reads `parseMajor` and `findWorkspaceApps` to say which build tool and which app a report came ' +
    'from. Both are general-purpose and squat in the scaffolder for historical reasons, but ' +
    '`findWorkspaceApps` carries `workspaceParents` and the workspace manifest constants with it, so ' +
    'lifting them out means editing the install path — the one path in this repo with the worst ' +
    'track record for silent breakage. Left in place deliberately: a consumer embedding the engine ' +
    'takes this module verbatim and never calls the installer, so the crossing costs it nothing.',
  'machine/platform.ts':
    'Re-exports `NodePlatform`, four lines naming the two `process.platform` values this daemon ' +
    'branches on. It is DEFINED in the scaffolder because `node-io.ts` needs it and that package may ' +
    'not import this one; re-exported here so the five runtime readers are unchanged. A type-level ' +
    'constant, not a code path — nothing of the installer runs.',
  'command/cli/ports/resolve/cli-port.ts':
    'Re-exports the dev-server port heuristics. `existing-config.ts` diagnoses a `.reticle.json` ' +
    'whose `port` is the app’s own dev-server port, so the set is defined there; the runtime ' +
    'readers (the dev-server probe, the no-session diagnosis) read it through here. Data, not a code ' +
    'path.',
  'telemetry/install-source.ts':
    'Re-exports `configWithInstallSource`. `init` is the only thing that writes `.reticle.json`, so ' +
    'the writer lives with it; this module stays the one place to read about install attribution.',
};

/** Every module in `reached` that imports the scaffolder package directly. */
function crossings(reached: Iterable<string>): string[] {
  return [...reached].filter((file) => importsOf(SRC, file).includes(CLI_ONLY_PACKAGE)).sort();
}

describe('library path boundary', () => {
  it('the root barrel never reaches the install-time surface', () => {
    const violations = crossings(reachableFrom(SRC, 'index.ts').keys()).filter(
      (file) => DECLARED_CROSSINGS[file] === undefined,
    );
    expect(violations).toEqual([]);
  });

  it('every declared crossing is still a real one', () => {
    // A declaration that has stopped being true is a stale exemption, and a stale exemption is a hole
    // nobody knows is open. If the reach is gone, the entry belongs deleted, not kept "just in case".
    const reached = new Set(crossings(reachableFrom(SRC, 'index.ts').keys()));
    for (const declared of Object.keys(DECLARED_CROSSINGS)) {
      expect(reached, `${declared} is declared but no longer crosses`).toContain(declared);
    }
  });

  it('the CLI entry point still owns the install-time surface', () => {
    // The counterpart, so the first assertion can never be satisfied by DELETING the install path —
    // which is the one fix that would pass this file and break the free product.
    expect(crossings(reachableFrom(SRC, 'command/cli.ts').keys()).length).toBeGreaterThan(0);
  });

  it('relative specifiers resolve the way the runtime resolves them', () => {
    // Across groups, which is what most cross-directory imports are now: two levels up, then the
    // group, then the directory.
    expect(resolveImport('surface/mcp/mcp.ts', '../../command/setup/confirm.js')).toBe(
      'command/setup/confirm.ts',
    );
    // Within a group, unchanged: one level up and along.
    expect(resolveImport('surface/mcp/mcp.ts', '../tools/tools.js')).toBe('surface/tools/tools.ts');
    expect(resolveImport('index.ts', './surface/tools/tools.js')).toBe('surface/tools/tools.ts');
    expect(resolveImport('index.ts', '@reticlehq/core')).toBeUndefined();
  });
});

// `relative` is imported for parity with the sibling graph guards; assert the shape it returns so a
// platform separator change cannot silently alter the POSIX comparisons above.
describe('path normalisation', () => {
  it('compares POSIX-separated paths on every platform', () => {
    expect(
      relative(SRC, join(SRC, 'command', 'setup', 'confirm.ts'))
        .split(sep)
        .join('/'),
    ).toBe('command/setup/confirm.ts');
  });
});
