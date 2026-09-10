import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MessageKind, RETICLE_PROTOCOL_VERSION } from './constants.js';
import { Verified } from '../verdict/verified-constants.js';
import { ContradictionKind } from '../verdict/findings.js';
import { RefusalReason } from '../telemetry-refusal.js';

/**
 * The written specification must describe the contract this code actually enforces.
 *
 * `openreality/SPEC.md` is meant to be readable by somebody outside this repository who is deciding
 * whether to implement it. That makes it the easiest thing here to get quietly wrong: prose does not
 * compile, nothing imports it, and a message kind added in code leaves the document describing a
 * protocol that no longer exists. A specification that is subtly untrue is worse than none, because
 * somebody builds against it.
 *
 * So the document names the message kinds, the version and the verdicts, and this reads them back
 * out of it and compares. The schemas themselves stay in code and are NOT copied into the document,
 * deliberately: two definitions of one contract is the drift problem, not the fix. The document
 * points at them and describes what they mean.
 */

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: import.meta.dirname,
  encoding: 'utf8',
}).trim();
const SPEC = readFileSync(join(REPO_ROOT, 'openreality', 'SPEC.md'), 'utf8');

/** The values in the first column of every table row, which is where the document lists names. */
function backtickedNamesIn(spec: string): Set<string> {
  return new Set([...spec.matchAll(/^\| `([a-z_-]+)`/gm)].map((m) => m[1] ?? ''));
}

describe('the written specification describes the contract the code enforces', () => {
  it('finds a specification to read at all', () => {
    // Without this, a moved or emptied document would make every check below pass over nothing.
    expect(SPEC.length).toBeGreaterThan(1000);
    expect(backtickedNamesIn(SPEC).size).toBeGreaterThan(5);
  });

  it('names exactly the message kinds that exist', () => {
    const named = backtickedNamesIn(SPEC);
    const inCode = Object.values(MessageKind);
    const missing = inCode.filter((kind) => !named.has(kind));
    expect(
      missing,
      'These message kinds exist in the code and are not in openreality/SPEC.md. Somebody reading ' +
        'the specification would build something that cannot talk to this.',
    ).toEqual([]);
  });

  it('names exactly the verdicts that exist', () => {
    const named = backtickedNamesIn(SPEC);
    const missing = Object.values(Verified).filter((verdict) => !named.has(verdict));
    expect(
      missing,
      'These verdicts exist in the code and are not in openreality/SPEC.md. The two that get ' +
        'dropped from documents are `unknown` and `no-fault`, and they are the two that make the ' +
        'other two mean anything.',
    ).toEqual([]);
  });

  it('states the protocol version the code speaks', () => {
    expect(
      SPEC.includes(`version is **${String(RETICLE_PROTOCOL_VERSION)}**`),
      `openreality/SPEC.md does not say the protocol version is ${String(RETICLE_PROTOCOL_VERSION)}.`,
    ).toBe(true);
  });

  it('still says that anomalies are part of the model', () => {
    // The part of the model that produces something nobody asked for. It is also the part most
    // easily dropped from a document, because no caller misses it -- and dropping it would leave a
    // specification for a tool that only answers questions it was handed.
    expect(SPEC).toMatch(/## \d+\. Anomalies/);
    const kinds = Object.values(ContradictionKind).length;
    expect(
      SPEC.includes(`${String(kinds)} kinds of contradiction`) ||
        SPEC.includes('twenty-three kinds of contradiction'),
      `The specification states a number of contradiction kinds that is not ${String(kinds)}.`,
    ).toBe(true);
  });

  it('still says a realm must refuse what it did not declare', () => {
    expect(SPEC).toMatch(/must \*\*refuse\*\*/);
    // Named because it is the one that stops a realm doing something adjacent and calling it done.
    expect(SPEC).toContain(RefusalReason.UNSUPPORTED);
  });

  it('still says every observation belongs to a window', () => {
    // A verdict with no window is a claim nobody can argue with, which is the same as no claim.
    expect(SPEC).toMatch(/scoped to a \*\*window\*\*/);
  });

  it('still states the rule that makes a verdict mean anything', () => {
    // The independence rule is the whole product. A specification that quietly loses it describes
    // something anybody could build and nobody should trust.
    expect(SPEC).toMatch(/independence rule/i);
    expect(SPEC).toMatch(/must not come from the same channel/i);
  });
});
