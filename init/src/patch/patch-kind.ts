/**
 * The outcome vocabulary shared by every conservative source patcher in `init` (Vite config, Next
 * config, Next root layout). One enum so a new patcher cannot invent a fourth status the reporter
 * has no symbol for.
 */

export const PatchKind = {
  APPLY: 'apply',
  ALREADY: 'already',
  MANUAL: 'manual',
} as const;
export type PatchKind = (typeof PatchKind)[keyof typeof PatchKind];

export type SourcePatch =
  | { kind: typeof PatchKind.APPLY; code: string }
  | { kind: typeof PatchKind.ALREADY }
  | { kind: typeof PatchKind.MANUAL; reason: string };
