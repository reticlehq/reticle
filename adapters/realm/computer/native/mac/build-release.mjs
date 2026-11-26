// Builds the two Mac programs of the package for every Mac: the helper (reticle-ax) and the HUD
// (reticle-hud), each for Apple silicon and Intel in one file. `prepack` runs it, so a person who
// installs the package needs no Swift compiler.
//
//   node native/mac/build-release.mjs
//
// Each program is signed. With APPLE_SIGNING_IDENTITY set (a "Developer ID Application" identity in
// the keychain), it is signed with that identity and the hardened runtime. Without it, it is signed
// ad hoc. An ad-hoc program that npm installs runs: npm does not mark its files as downloaded, so
// Gatekeeper does not check them. macOS gives the Accessibility and Screen Recording permission to
// the application that starts the helper (the terminal, the agent), so a new build of the helper
// does not ask again.
//
// Not on a Mac it builds nothing and says so: the package then builds the programs on first use.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const build = join(here, 'build');
const PROGRAMS = [
  ['reticle-ax', 'reticle-ax.swift'],
  ['reticle-hud', 'hud.swift'],
];
// The oldest macOS the programs run on.
const MIN_MACOS = '13.0';

if ('darwin' !== process.platform) {
  process.stderr.write(
    'build-release: not on macOS, so no Mac program was built. The package builds it on first use.\n',
  );
  process.exit(0);
}

const run = (file, args) => execFileSync(file, args, { stdio: ['ignore', 'ignore', 'inherit'] });
const identity = process.env.APPLE_SIGNING_IDENTITY ?? '';
mkdirSync(build, { recursive: true });
const work = join(tmpdir(), `reticle-mac-build-${String(process.pid)}`);
mkdirSync(work, { recursive: true });
try {
  for (const [program, source] of PROGRAMS) {
    const slices = ['arm64', 'x86_64'].map((arch) => {
      const out = join(work, `${program}-${arch}`);
      run('swiftc', [
        '-O',
        '-target',
        `${arch}-apple-macos${MIN_MACOS}`,
        join(here, source),
        '-o',
        out,
      ]);
      return out;
    });
    const out = join(build, program);
    run('lipo', ['-create', ...slices, '-output', out]);
    run(
      'codesign',
      '' === identity
        ? ['--force', '--sign', '-', out]
        : ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, out],
    );
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.stderr.write(
  `build-release: built ${PROGRAMS.map(([p]) => p).join(' and ')} for arm64 and x86_64, signed ${'' === identity ? 'ad hoc' : 'with a Developer ID'}.\n`,
);
