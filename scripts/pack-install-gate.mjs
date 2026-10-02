// Run real prepacks once. Every install cell consumes these exact npm packages from this run.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageDigest, pnpm, publishablePackages } from '../apps/e2e/install-packages.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(process.argv[2] ?? join(root, 'artifacts/install-packages'));
mkdirSync(destination, { recursive: true });
if (readdirSync(destination).length !== 0)
  throw new Error(`pack destination must be empty: ${destination}`);
const packages = publishablePackages(root);
if (!packages.length) throw new Error('no publishable packages found');
pnpm(
  [
    '-r',
    '--workspace-concurrency=1',
    ...packages.flatMap((pkg) => ['--filter', pkg.name]),
    'pack',
    '--pack-destination',
    destination,
  ],
  { cwd: root, stdio: 'inherit', timeout: 20 * 60_000 },
);
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
writeFileSync(
  join(destination, 'manifest.json'),
  `${JSON.stringify(
    {
      sha,
      packages: packages.map((pkg) => ({
        ...pkg,
        sha256: packageDigest(readFileSync(join(destination, pkg.filename))),
      })),
    },
    null,
    2,
  )}\n`,
);
console.log(`Packed ${packages.length} packages for ${sha} into ${destination}`);
