import { describe, expect, it } from 'vitest';
import { OVP_VERSION, VerificationRunSchema } from './run.js';
import { CHANNEL_DEFAULTS, ChannelId, Grade, Independence } from './channel.js';
import { Surface } from './subject.js';

/**
 * A run document has to say where its evidence was standing.
 *
 * The rule and the type for a second vantage point landed already: a `Witness` observes and cannot
 * act, and its silence against the subject's claim convicts. But the DOCUMENT still described one
 * `subject` and one `channels` — so a reader handed the artifact could not tell which evidence came
 * from outside the subject, which is the entire property that makes a witness worth asking.
 *
 * Evidence already carries its own `provenance.subject`, so the correlation was technically
 * derivable. That is not the same as declared: `channels` exists at the top of a run precisely
 * because what a vantage point CLAIMS it can see is an assertion to be checked, not something to be
 * inferred from what it happened to report. A witness deserves the same treatment, and for the
 * sharper reason — a witness that calls itself independent while reading the app's own cache is the
 * costliest lie available here, and a reader cannot begin to doubt a declaration nobody wrote down.
 */

const base = {
  ovp: OVP_VERSION,
  id: 'run-1',
  verifier: { name: 'reticle', version: '3.0.0' },
  subject: { surface: Surface.WEB, instance: 'app', epoch: 1 },
  channels: [{ id: ChannelId.UI, ...CHANNEL_DEFAULTS[ChannelId.UI] }],
  startedAt: 0,
  endedAt: 1,
};

const ordersDb = {
  name: 'orders-db',
  subject: { surface: Surface.SERVICE, instance: 'orders-db', epoch: 1 },
  channels: [
    {
      id: ChannelId.STATE,
      ...CHANNEL_DEFAULTS[ChannelId.STATE],
      // The whole reason a second vantage point is worth the round trip: it did not cause what it
      // reports. The in-page `state` channel is actuation-derived; this one is another process.
      independence: Independence.INDEPENDENT,
      grade: Grade.CONSEQUENCE,
    },
  ],
};

describe('a run that consulted something outside the subject', () => {
  it('records the witness, its own subject, and what it claimed it could see', () => {
    const parsed = VerificationRunSchema.parse({ ...base, witnesses: [ordersDb] });
    expect(parsed.witnesses).toHaveLength(1);
    expect(parsed.witnesses[0]?.subject.instance).toBe('orders-db');
    expect(parsed.witnesses[0]?.channels[0]?.independence).toBe(Independence.INDEPENDENT);
  });

  it('defaults to none, so every run written before this stays readable', () => {
    // Additive by construction: a document that consulted nothing outside the subject says so by
    // saying nothing, and an older artifact does not become invalid for lacking a field.
    expect(VerificationRunSchema.parse(base).witnesses).toEqual([]);
  });

  it('refuses a witness with no subject of its own', () => {
    // A witness whose subject is implied is a witness a reader cannot place. The whole claim is
    // "this came from somewhere else" — unnamed, it is indistinguishable from the actor's own view.
    const { subject: _omitted, ...noSubject } = ordersDb;
    expect(() => VerificationRunSchema.parse({ ...base, witnesses: [noSubject] })).toThrow();
  });

  it('refuses an unnamed witness', () => {
    const { name: _omitted, ...unnamed } = ordersDb;
    expect(() => VerificationRunSchema.parse({ ...base, witnesses: [unnamed] })).toThrow();
  });
});
