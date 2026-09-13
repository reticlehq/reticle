import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { MessageKind, RETICLE_PROTOCOL_VERSION } from './constants/constants.js';
import { CHANNEL_INDEPENDENCE, ChannelId } from './channel.js';
import { VerdictStatus } from '../verdict/verification-run.js';
import { Verified } from '../verdict/verified-constants.js';
import { ContradictionKind } from '../verdict/findings.js';
import { AnomalyKind } from '@reticlehq/openreality';
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
  });

  it('names every anomaly kind the protocol defines', () => {
    // This used to assert a COUNT, and of `ContradictionKind` -- Reticle's own registry, which is
    // deliberately larger than the protocol's list and grows for reasons the protocol does not
    // care about. A count is also the weakest possible check: it passes while every name is wrong.
    //
    // The protocol's kinds are the domain-independent ones, and enumerating them is both the
    // stronger assertion and the one that stays true as the implementation adds its own.
    const named = backtickedNamesIn(SPEC);
    const missing = Object.values(AnomalyKind).filter((kind) => !named.has(kind));
    expect(
      missing,
      'These anomaly kinds are defined in @reticlehq/openreality and are not named in SPEC.md.',
    ).toEqual([]);
  });

  it('still has an implementation registry larger than the protocol names', () => {
    // The relationship the two lists are supposed to have. If Reticle's registry ever shrank to
    // the protocol's list, the protocol would have quietly become a description of this one
    // implementation -- which is the failure the whole profile design exists to prevent.
    expect(Object.values(ContradictionKind).length).toBeGreaterThan(
      Object.values(AnomalyKind).length,
    );
  });

  it('still says a realm must refuse what it did not declare', () => {
    // Case-insensitive: the document states its rules with RFC 2119 keywords, so this reads
    // `MUST **refuse**`. The bold is what is being checked -- it marks the rule as a rule rather
    // than as a sentence somebody could read past.
    expect(SPEC).toMatch(/must \*\*refuse\*\*/i);
    // Named because it is the one that stops a realm doing something adjacent and calling it done.
    expect(SPEC).toContain(RefusalReason.UNSUPPORTED);
  });

  it('still says every observation belongs to a window', () => {
    // A verdict with no window is a claim nobody can argue with, which is the same as no claim.
    expect(SPEC).toMatch(/scoped to a \*\*window\*\*/);
  });

  it('names every channel an implementation can declare', () => {
    // The conformance profiles are defined over channels, so a document that does not list them
    // leaves an implementer unable to fill in the one JSON file registering requires. This was
    // exactly the state of it: the channel model shipped, the profiles were written against it,
    // and the specification never mentioned either.
    const named = backtickedNamesIn(SPEC);
    const missing = Object.values(ChannelId).filter((channel) => !named.has(channel));
    expect(missing, 'These channels exist in the code and are not in openreality/SPEC.md.').toEqual(
      [],
    );
  });

  it('says which channels can be evidence about the action that caused them', () => {
    // The independence rule is only enforceable if the document says which side of the line each
    // channel is on. Prose alone made it a judgement re-made by hand at every new check.
    for (const channel of Object.values(ChannelId)) {
      const marking = CHANNEL_INDEPENDENCE[channel];
      const row = new RegExp(`^\\| \`${channel}\`.*\\b${marking}\\b`, 'm');
      expect(SPEC, `openreality/SPEC.md does not say that \`${channel}\` is ${marking}.`).toMatch(
        row,
      );
    }
  });

  it('names the vocabulary a run summary is written in', () => {
    // A second vocabulary, for a second question -- a run over many claims needs a word for "some
    // held and some did not", and no single claim can be that. Both are in the document precisely
    // so nobody uses one where the other belongs, which is how `partial` reached a reader who had
    // only ever been told about four verdicts.
    const named = backtickedNamesIn(SPEC);
    const missing = Object.values(VerdictStatus).filter((status) => !named.has(status));
    expect(missing, 'These run summary values are not in openreality/SPEC.md.').toEqual([]);
  });

  it('states the rule for correcting a verdict once late evidence lands', () => {
    expect(SPEC).toMatch(/### Revision/);
    expect(SPEC).toMatch(/supersede/i);
  });

  it('still states the rule that makes a verdict mean anything', () => {
    // The independence rule is the whole product. A specification that quietly loses it describes
    // something anybody could build and nobody should trust.
    expect(SPEC).toMatch(/independence rule/i);
    expect(SPEC).toMatch(/must not come from the channel that performed the action/i);
    // And the half that makes it checkable rather than aspirational: a disagreement may only
    // convict when one side is independent. Prose alone is what MCAS had.
    expect(SPEC).toMatch(/at least one of the two channels is independent/i);
  });
});

/**
 * The gap list is the half of the document that rots.
 *
 * Everything else is a description of something that exists, so building the thing and forgetting
 * the prose leaves an obvious hole. A gap is the opposite: CLOSING one leaves the document reading
 * exactly as it always did, and now lying in the direction that costs an implementer most -- they
 * do not build on what they are told is missing.
 *
 * It happened here. Five commits landed a conformance suite and a revision mechanism, and the
 * section listing both as absent was not touched, in a document whose own commit message was about
 * not letting it drift.
 *
 * So each entry below names a claim of absence and the thing whose existence would falsify it.
 */
const ABSENCE_CLAIMS: readonly { readonly phrase: RegExp; readonly falsifiedBy: string }[] = [
  { phrase: /No conformance suite/i, falsifiedBy: 'conformance/score.mjs' },
  { phrase: /[Vv]erdicts cannot be revised/, falsifiedBy: 'core/src/verdict/revision.ts' },
  { phrase: /No conformance driver/i, falsifiedBy: 'conformance/drive.mjs' },
  {
    phrase: /the (only|sole) implementation is/i,
    falsifiedBy: 'openreality/src/reference/service-realm.ts',
  },
];

describe('the specification does not claim to be missing something it has', () => {
  for (const { phrase, falsifiedBy } of ABSENCE_CLAIMS) {
    it(`does not say ${String(phrase)} while ${falsifiedBy} exists`, () => {
      const exists = existsSync(join(REPO_ROOT, falsifiedBy));
      if (!exists) return;
      expect(
        SPEC,
        `openreality/SPEC.md lists this as a gap, and ${falsifiedBy} exists. Either the entry is ` +
          'stale or the file is not what it looks like -- and a specification that understates ' +
          'itself is read by somebody deciding not to build on it.',
      ).not.toMatch(phrase);
    });
  }
});
