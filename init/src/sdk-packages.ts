import type { Framework, UiLibrary } from '@/detect/detect.js';
import { PACKAGE_JSON } from '@/detect/workspace-apps.js';
import { frameworkPackages } from '@/plan/plan.js';
import type { InitIo } from '@/run-types.js';

const NODE_MODULES_DIR = 'node_modules';

/**
 * Are the SDK packages actually on disk, whatever the install step reported?
 *
 * `dependsOnInstall` exists to stop init writing a `next.config.ts` that imports a package which is
 * not there — that took a dev server down once, and installing Reticle must never be why an app
 * stops booting. The invariant it protects is "the import RESOLVES", but it was gated on "our
 * install subprocess exited 0", and those come apart in exactly the situation the failure creates:
 * init tells the user to install by hand, they do, they re-run init, the install step fails again
 * (wrong package manager, not on PATH) and every wiring step is skipped a second time. Reported from
 * a Next 16 app where npm had already installed both packages successfully — leaving an init that
 * could not be retried into working, which is the shape this guard was written to prevent.
 *
 * Reading node_modules answers the real question and costs one `exists` call per package.
 */
export function sdkPackagesPresent(
  framework: Framework,
  uiLibrary: UiLibrary,
  io: Pick<InitIo, 'exists'>,
): boolean {
  const packages = frameworkPackages(framework, uiLibrary);
  return (
    packages.length > 0 &&
    packages.every((p) => io.exists(`${NODE_MODULES_DIR}/${p}/${PACKAGE_JSON}`))
  );
}

/** Does package.json list every SDK package? On disk without this, the next clean install drops them. */
export function sdkPackagesDeclared(
  framework: Framework,
  uiLibrary: UiLibrary,
  io: Pick<InitIo, 'readFile'>,
): boolean {
  let manifest: unknown;
  try {
    manifest = JSON.parse(io.readFile(PACKAGE_JSON) ?? '{}');
  } catch {
    return false;
  }
  const m = (manifest ?? {}) as Record<string, Record<string, unknown> | undefined>;
  return frameworkPackages(framework, uiLibrary).every(
    (p) => m['dependencies']?.[p] !== undefined || m['devDependencies']?.[p] !== undefined,
  );
}
