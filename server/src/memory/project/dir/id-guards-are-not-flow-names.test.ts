import { describe, expect, it } from 'vitest';
import { isValidSessionId, isValidRunId, isValidFlowName } from './reticle-dir.js';
import { safeProjectId } from '@/language/flows/flow-result.js';

/**
 * A session id is a DIRECTORY NAME. A flow name is an ADDRESS. They are not the same guard.
 *
 * They were one pattern, because they once had the same shape. When flow names became namespaced —
 * `onboarding/signup` is how a composite names the sub-journey it invokes — widening that pattern
 * silently widened the session and run guards along with it, and those are joined into
 * `.reticle/sessions/<id>/` and written to. A session LABEL is supplied by the tab, so a separator
 * there is the page choosing where on disk Reticle writes.
 *
 * One existing test caught it, which is the only reason this is a note rather than a shipped hole.
 * This file pins the DISTINCTION so the two cannot quietly converge again — the next person to
 * widen a name pattern has to come past a test that says why these differ.
 */

describe('ids that become directory names', () => {
  it('refuse a separator, which a flow name now allows', () => {
    expect(isValidFlowName('onboarding/signup')).toBe(true);
    expect(isValidSessionId('onboarding/signup')).toBe(false);
    expect(isValidRunId('onboarding/signup')).toBe(false);
  });

  /**
   * A projectId is the fourth id joined into a directory path, and it was the one this file did not
   * cover -- while being validated by `isValidFlowName`, the ADDRESS guard, rather than the segment
   * guard the other three use.
   *
   * It arrives in a session's HELLO, so a page could choose how deep under `.reticle/` Reticle
   * writes. It could not escape the directory -- no `..`, no leading separator -- so this is a page
   * naming nested directories rather than a page reaching the disk. Still the wrong guard, and the
   * brand said so out loud: `isValidFlowName` narrows to `projectId is FlowName`, for a value that
   * is a project.
   */
  it('refuse a separator in a projectId too, which is a directory name and not an address', () => {
    expect(safeProjectId('onboarding/signup')).toBeUndefined();
    expect(safeProjectId('a/b')).toBeUndefined();
  });

  it('still accept an ordinary projectId', () => {
    expect(safeProjectId('82e20b628df9cb09')).toBe('82e20b628df9cb09');
  });

  it('still accept the ordinary single-segment ids everything uses', () => {
    for (const id of ['s7dbe002a-5c5a-451b', 'run_2026', 'abc123']) {
      expect(isValidSessionId(id), id).toBe(true);
      expect(isValidRunId(id), id).toBe(true);
    }
  });

  it('refuse every escape, on all three', () => {
    for (const bad of ['../escape', 'a/../b', '/abs', '.hidden', 'a\\b', '']) {
      expect(isValidSessionId(bad), bad).toBe(false);
      expect(isValidRunId(bad), bad).toBe(false);
      expect(isValidFlowName(bad), bad).toBe(false);
      expect(safeProjectId(bad), bad).toBeUndefined();
    }
  });
});
