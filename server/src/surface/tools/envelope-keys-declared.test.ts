import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EnvelopeKey, sessionEnvelopeShape } from './tool-kit.js';

/**
 * Every key spliced onto a tool result must be DECLARED on the result schema.
 *
 * A schema-strict MCP client validates `structuredContent` against the tool's `outputSchema` and
 * drops what is not declared. So an undeclared envelope key is not a cosmetic omission — the
 * channel is built, fires, and is thrown away before the agent sees it, with nothing anywhere
 * saying so. It is the same silent-failure shape as the telemetry contract: no throw, no red test,
 * the data simply never arrives.
 *
 * This has now happened twice. First `warning`, declared on `reticle_act` and nowhere else, so a
 * throttled tab returned a healthy-looking result from every other tool. The fix was a shared
 * envelope shape — and a comment on that shape explaining exactly this hazard.
 *
 * Then 2.6.0 added four more channels and declared none of them:
 *
 *   - `verify_next` — the verdict nudge, the largest known lever on whether a session produces a
 *     verdict at all;
 *   - `feedback_invite` — the contextual feedback channel that drives much of the fix backlog;
 *   - `version_skew` — often the single fact that explains everything else in a session;
 *   - `feedback_undelivered` — a report accepted and then lost, which only the reporter can act on.
 *
 * A comment did not stop it. This does: the shape is DERIVED from `EnvelopeKey`, and the test below
 * reads the splice sites and fails on any key that is not a member.
 */
const INVOKE_TOOL = fileURLToPath(new URL('./invoke-tool.ts', import.meta.url));

describe('the session envelope cannot drift from what is spliced onto results', () => {
  it('declares every key in EnvelopeKey', () => {
    for (const key of Object.values(EnvelopeKey)) {
      expect(sessionEnvelopeShape[key], `${key} is spliced but not declared`).toBeDefined();
    }
    expect(Object.keys(sessionEnvelopeShape).sort()).toEqual(
      [...Object.values(EnvelopeKey)].sort(),
    );
  });

  it('every key invoke-tool actually splices is a member of EnvelopeKey', () => {
    // Reads the source rather than driving a tool: the keys are spliced from four different
    // branches under conditions (a throttled tab, a one-shot latch that has not fired, a pending
    // update check) that a unit test would have to fake one at a time — and the one that gets
    // forgotten is precisely the one that goes undeclared. The source is the complete list.
    const src = readFileSync(INVOKE_TOOL, 'utf8');
    const spliced = new Set<string>();
    // `envelope['x'] = …`
    for (const m of src.matchAll(/envelope\['([a-z_]+)'\]\s*=/g)) spliced.add(m[1] ?? '');
    // `...(x !== undefined ? { some_key: x } : {})` — the object-spread form used above the
    // envelope, which lands the same keys on the same result. Both sites use `EnvelopeKey` today;
    // these patterns exist to catch the next one that does not.
    for (const m of src.matchAll(/\?\s*\{\s*'?([a-z_]+)'?:/g)) spliced.add(m[1] ?? '');

    const known = new Set<string>(Object.values(EnvelopeKey));
    // Only assert over keys that LOOK like envelope channels — the regexes above also catch
    // ordinary result fields, and a guard that fails on unrelated code gets deleted.
    const undeclared = [...spliced].filter(
      (k) => !known.has(k) && ENVELOPE_SHAPED.some((p) => k.includes(p)),
    );
    expect(undeclared, 'spliced onto a result but not in EnvelopeKey').toEqual([]);
  });

  it('still splices the four channels 2.6.0 added — the guard is not passing over an empty file', () => {
    // A scanner that matches zero keys passes forever. The splice sites now use the constants, so
    // pin those: if a channel is deleted or renamed the reference goes with it.
    const src = readFileSync(INVOKE_TOOL, 'utf8');
    for (const member of [
      'VERIFY_NEXT',
      'FEEDBACK_INVITE',
      'VERSION_SKEW',
      'FEEDBACK_UNDELIVERED',
    ]) {
      expect(src, `EnvelopeKey.${member} should still be spliced`).toContain(
        `EnvelopeKey.${member}`,
      );
    }
  });
});

/** Substrings that mark a spliced key as one of the guidance channels this guard is about. */
const ENVELOPE_SHAPED = [
  'feedback',
  'session',
  'verify',
  'update',
  'version',
  'control',
  'warning',
];
