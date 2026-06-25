/**
 * Project-identity derivation for `iris init` — the Next/HTML/.iris.json side of the same scheme the
 * Vite plugin uses at build time. Kept algorithmically identical (slug of package.json name + 8-char
 * hash of the absolute root) so a Vite app's plugin-stamped projectId matches what init records.
 */

import { createHash } from 'node:crypto';
import { basename } from 'node:path';

/** `@acme/web` → `acme-web`; non-alphanumerics collapse to single dashes; edges trimmed. */
export function slugifyPackageName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Short, stable hex fingerprint of the absolute project root. */
export function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 8);
}

/**
 * Derive the stable projectId from the package name (may be undefined) and the absolute root path.
 * Falls back to the root folder name, then "app". Pure.
 */
export function deriveProjectId(pkgName: string | undefined, rootPath: string): string {
  const fromName = pkgName !== undefined ? slugifyPackageName(pkgName) : '';
  const base = fromName.length > 0 ? fromName : slugifyPackageName(basename(rootPath)) || 'app';
  return `${base}-${shortHash(rootPath)}`;
}

/** Pull a string `name` out of an already-parsed package.json object, or undefined. */
export function packageName(pkg: unknown): string | undefined {
  if (typeof pkg === 'object' && pkg !== null) {
    const name = (pkg as Record<string, unknown>)['name'];
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return undefined;
}
