/**
 * A flow file from a different FORMAT is not a corrupt flow file.
 *
 * `FLOW_FILE_VERSION` is a `z.literal`, so a file carrying any other number fails the schema like a
 * typo does and the reader answers "flow file is malformed — fix or regenerate it". That sends
 * somebody to hunt a JSON syntax error in a file that is perfectly well-formed and was written by a
 * newer (or older) Reticle.
 *
 * `project.json` already has this distinction — `ProjectReadError.WRONG_VERSION`, separate from a
 * parse failure — and the argument written beside it is the same one: the two need different fixes.
 * Malformed means "repair or regenerate this file". Wrong version means "the file is fine, the
 * READER is the wrong one", and the remedy is to upgrade or downgrade Reticle, not to touch the
 * flow.
 *
 * This lands BEFORE the format ever changes, deliberately. The first bump is precisely when the
 * wrong answer gets given at scale, and a version error added at the same time as the bump would
 * still be missing for every reader already in the field. Shipping it first is what makes the next
 * bump legible to the Reticle people already have.
 *
 * Checked ahead of the schema rather than folded into the zod failure: when the version does not
 * match, nothing else about the file can be trusted to mean what this reader thinks it means, so
 * reporting the FIRST unrelated field that happens to fail would be noise about the wrong thing.
 */

import { describe, expect, it } from 'vitest';
import { FLOW_FILE_VERSION, FlowErrorCode } from '@reticlehq/core';
import { parseFlowFileText } from './flow-expect-grammar.js';

const flowAt = (version: unknown): string =>
  JSON.stringify({ version, name: 'f', createdAt: 0, steps: [] });

describe('a flow file written by a different Reticle', () => {
  it('reports a wrong version, not a malformed file', () => {
    const out = parseFlowFileText(flowAt(FLOW_FILE_VERSION + 1));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe(FlowErrorCode.WRONG_VERSION);
  });

  it('says which version it found and which it reads', () => {
    const out = parseFlowFileText(flowAt(FLOW_FILE_VERSION + 1));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.detail).toContain(String(FLOW_FILE_VERSION + 1));
    expect(out.detail).toContain(String(FLOW_FILE_VERSION));
  });

  it('does not tell the author to regenerate a file that is not damaged', () => {
    const out = parseFlowFileText(flowAt(FLOW_FILE_VERSION + 1));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.detail ?? '').not.toContain('malformed');
  });

  /** An OLDER file is the same situation from the other side and must read the same way. */
  it('treats an older version the same way', () => {
    const out = parseFlowFileText(flowAt(0));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe(FlowErrorCode.WRONG_VERSION);
  });

  /** A file with no version at all is not a versioned file — that IS malformed. */
  it('still calls a missing version malformed', () => {
    const out = parseFlowFileText(JSON.stringify({ name: 'f', createdAt: 0, steps: [] }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe(FlowErrorCode.PARSE_FAILED);
  });

  /** A non-numeric version is a damaged field, not a different format. */
  it('still calls a non-numeric version malformed', () => {
    const out = parseFlowFileText(flowAt('two'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe(FlowErrorCode.PARSE_FAILED);
  });

  /** The current version is unaffected, and a real syntax error still reads as one. */
  it('still parses the current version', () => {
    expect(parseFlowFileText(flowAt(FLOW_FILE_VERSION)).ok).toBe(true);
  });

  it('still reports broken JSON as broken JSON', () => {
    const out = parseFlowFileText('{ not json');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe(FlowErrorCode.PARSE_FAILED);
  });
});
