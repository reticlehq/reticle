import { afterAll, describe, it } from 'vitest';
import { RuleTester } from '@typescript-eslint/rule-tester';
import { noInternalTags } from './no-internal-tags.js';

RuleTester.afterAll = afterAll;
RuleTester.it = it;
RuleTester.itOnly = it.only;
RuleTester.describe = describe;

const ruleTester = new RuleTester();

/**
 * Every invalid case below is a real comment that shipped in this repo. Every valid case is prose the
 * rule must NOT punish — a rule that fires on ordinary technical writing gets disabled, and a disabled
 * rule enforces nothing.
 */
/**
 * The project rule names four surfaces: comments, file names, directory names and test descriptions.
 * The rule enforced two. A path is the FIRST thing a reader meets, before any comment, so a module
 * called `n5-ring-buffer.ts` states the banned shape in the loudest place available.
 *
 * `filename` is relative here because the rule judges the path relative to the project root: an
 * absolute path runs through directories nobody chose as part of this codebase, and flagging a CI
 * runner's workspace would report a violation the author cannot fix.
 */
ruleTester.run('no-internal-tags (paths)', noInternalTags, {
  valid: [
    { code: '// ordinary', filename: 'packages/server/src/ring-buffer.ts' },
    // Each of these matches the code SHAPE and must not fire: the boundaries, not the case, are what
    // rule them out.
    { code: '// ordinary', filename: 'apps/e2e/install-gate.ts' },
    { code: '// ordinary', filename: 'packages/core/src/utf8-decode.ts' },
    { code: '// ordinary', filename: 'packages/server/src/http2-client.ts' },
    { code: '// ordinary', filename: 'packages/core/src/base64.ts' },
    // Established terms keep their exemption in a path, same as in prose.
    { code: '// ordinary', filename: 'packages/server/src/s3-upload.ts' },
    { code: '// ordinary', filename: 'packages/browser/src/v8-heap.ts' },
    // No file to judge: a RuleTester case or a piped snippet.
    { code: '// ordinary' },
  ],
  invalid: [
    {
      code: '// ordinary',
      filename: 'packages/server/src/n5-ring-buffer.ts',
      errors: [{ messageId: 'pathTag', data: { tag: 'n5' } }],
    },
    {
      // A DIRECTORY name is the other half the project rule names.
      code: '// ordinary',
      filename: 'packages/server/src/w11/ring-buffer.ts',
      errors: [{ messageId: 'pathTag', data: { tag: 'w11' } }],
    },
    {
      code: '// ordinary',
      filename: 'packages/server/src/replay-v2.2.0.ts',
      errors: [{ messageId: 'pathTag', data: { tag: 'v2.2.0' } }],
    },
  ],
});

ruleTester.run('no-internal-tags', noInternalTags, {
  valid: [
    { code: '// Flush the journal tail so the last events reach disk.' },
    { code: '/** Welford M2 accumulator for streaming variance. */' },
    { code: '// Falls back to HTTP/2 when the server supports it.' },
    { code: '// Retries up to 3 times with linear backoff.' },
    { code: '// See the H2 heading in the rendered docs.' },
    { code: '// Matches UTF-8 encoded payloads only.' },
    // A version of a THIRD-PARTY thing is not an internal tracking string.
    { code: '// Requires @playwright/mcp 0.0.76 or newer.' },
    // Test descriptions are scanned too, so ordinary ones must stay legal.
    { code: "describe('formatBuddyStatus', () => {});" },
    { code: "it('falls back to HTTP/2 when available', () => {});" },
    // Established technical terms that happen to match the code shape.
    { code: '// Targets ES5 for the legacy bundle.' },
    { code: '// Works around an IE11 layout quirk.' },
    { code: '// Uploads land in S3 via EC2.' },
    // A third-party version is prose, not an internal tracking string.
    { code: '// React v18.2.0 changed this behaviour.' },
    // An external spec citation is a real reference a reader can follow.
    { code: '// Cookie parsing follows RFC 6265 §5.2.' },
  ],
  invalid: [
    {
      code: '/** The durable causal journal (v2.2.0 W2) */',
      errors: [{ messageId: 'internalTag' }, { messageId: 'internalTag' }],
    },
    {
      code: '// Blind-spot detection (B17, the detectable half)',
      errors: [{ messageId: 'internalTag' }],
    },
    {
      code: '// routing (§4.3) — the view renders but the URL is wrong',
      errors: [{ messageId: 'internalTag' }],
    },
    { code: '// Widened (W3)', errors: [{ messageId: 'internalTag' }] },
    { code: '// surface consolidation W10.3', errors: [{ messageId: 'internalTag' }] },
    { code: '// anti-reward-hacking (B37)', errors: [{ messageId: 'internalTag' }] },
    // The project rule names TEST DESCRIPTIONS explicitly, and these are real ones that survived a
    // repo-wide cleanup because a comment-only rule could not see a string literal.
    {
      code: "describe('gate — anti-reward-hacking (B37)', () => {});",
      errors: [{ messageId: 'internalTag' }],
    },
    {
      code: "describe('mergeTools (W10.3 surface consolidation)', () => {});",
      errors: [{ messageId: 'internalTag' }],
    },
    {
      code: "it('allows richer payloads (W4 will add fields)', () => {});",
      errors: [{ messageId: 'internalTag' }],
    },
    // The shapes an exemption-by-default rule silently permitted: a design-doc pointer attributed to
    // an internal document, and our OWN product name making a banned version string legal.
    { code: '// see PLAN §4.3 for the derivation', errors: [{ messageId: 'internalTag' }] },
    { code: '// new in Reticle v2.2.0', errors: [{ messageId: 'internalTag' }] },
  ],
});
