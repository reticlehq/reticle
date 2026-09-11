// Deterministic re-check for the fix-loop ablation. A regression is FIXED iff every marker
// string it injected is gone from its source files. Sound for any fix (revert OR rewrite): removing the
// buggy code is necessary to fix the bug, so absence-of-marker is a reliable "fixed" signal — and it needs
// no running app, so re-check is instant and deterministic (the ablation's fixed-correctly oracle).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { filesOf, signaturesOf } from '../harness/inject.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function fileText(absPath) {
  try {
    return readFileSync(absPath, 'utf8');
  } catch {
    return '';
  }
}

/** True when none of the regression's injected markers remain in its files. */
export function isFixed(id) {
  const signatures = signaturesOf(id);
  if (signatures.length === 0) return null; // not fix-loop-checkable (no registered marker)
  const text = filesOf(id)
    .map((f) => fileText(f.startsWith('/') ? f : resolve(ROOT, f)))
    .join('\n');
  return signatures.every((sig) => !text.includes(sig));
}
