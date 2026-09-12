// Generate the language-neutral form of the Open Verification Protocol.
//
// The TypeScript is the AUTHORING form and the JSON Schema is the CONTRACT. That direction is
// deliberate and is the one thing about this file worth defending: two hand-written definitions of
// one contract is the drift problem, not the fix. Nobody writes JSON Schema here. It is generated,
//
// ONE THING THIS CANNOT CARRY, and it decides how rules get written here: a `.refine()` does
// not survive. `zod-to-json-schema` emits the object and discards the predicate, with no
// warning, so a conditional MUST written that way is enforced for people who install the
// TypeScript and absent for everybody this file exists to serve.
//
// So the package has none. Both conditional rules in it are UNIONS, which the generator does
// express: `anyOf` with the conditional field in the branch's `required`. That is pinned by
// `src/refinements-reach-the-contract.test.ts`, which fails on any refinement -- including one
// added in good faith -- so the choice between "shape it as a union" and "declare a divergence
// and point at prose" gets made deliberately rather than by silence.
// every build, from the same zod that the reference implementation validates against, so a schema
// that disagrees with the code is not a thing that can exist.
//
// `zod-to-json-schema` is a build-time devDependency and never ships. What ships is `schema/*.json`
// plus `dist/`, so an implementation in Python, Go or Rust conforms by validating against the JSON
// and needs none of this package's code.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import * as ovp from '../dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// Emitted into `dist/`, like core's wire schemas, and for the same two reasons: generated output
// is not source and does not belong in git, and a generator that writes into the tree fights the
// formatter on every build -- twenty-two files, every time, blocking a commit that changed none
// of them.
const OUT = join(HERE, '..', 'dist', 'schema');

/** The base every `$id` hangs off. Stable: a moved schema url is a broken contract. */
const BASE = 'https://openreality.dev/schema/v1';

/**
 * What gets published, and under what name.
 *
 * The whole vocabulary, not a chosen subset. A protocol that publishes its envelope and keeps its
 * payload shapes in one vendor's TypeScript has published a shape and withheld the contract — the
 * reader can see what a message looks like and not what it may contain.
 */
// Exported so the guard can read the same map the generator does. Two copies of "what the
// contract contains" would be the drift this file exists to prevent, one level up.
export const SCHEMAS = Object.freeze({
  'subject-ref': ovp.SubjectRefSchema,
  'fixture-ref': ovp.FixtureRefSchema,
  reversal: ovp.ReversalSchema,
  invalidation: ovp.InvalidationSchema,
  'channel-descriptor': ovp.ChannelDescriptorSchema,
  intent: ovp.IntentSchema,
  claim: ovp.ClaimSchema,
  assertion: ovp.AssertionSchema,
  predicate: ovp.PredicateSchema,
  match: ovp.MatchSchema,
  constraint: ovp.ConstraintSchema,
  'constraint-violation': ovp.ConstraintViolationSchema,
  capability: ovp.CapabilitySchema,
  handle: ovp.HandleSchema,
  action: ovp.ActionSchema,
  'action-receipt': ovp.ActionReceiptSchema,
  window: ovp.WindowSchema,
  observation: ovp.ObservationSchema,
  provenance: ovp.ProvenanceSchema,
  evidence: ovp.EvidenceSchema,
  'blind-spot': ovp.BlindSpotSchema,
  coverage: ovp.CoverageSchema,
  anomaly: ovp.AnomalySchema,
  'verdict-record': ovp.VerdictRecordSchema,
  flow: ovp.FlowSchema,
  repair: ovp.RepairSchema,
  belief: ovp.BeliefSchema,
  implementation: ovp.ImplementationSchema,
  // The one a consumer actually validates: a whole verification, as it crosses the wire.
  'verification-run': ovp.VerificationRunSchema,
});

export function buildSchemas(schemas = SCHEMAS) {
  const built = {};
  for (const [name, schema] of Object.entries(schemas)) {
    built[name] = { $id: `${BASE}/${name}.json`, ...zodToJsonSchema(schema, { name }) };
  }
  return built;
}

function main() {
  mkdirSync(OUT, { recursive: true });
  const built = buildSchemas();
  for (const [name, schema] of Object.entries(built)) {
    writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(schema, null, 2)}\n`);
  }
  // stderr, not stdout. This runs inside `prepack`, so anything printed on stdout is prepended
  // to the output of whatever invoked the pack, and `npm pack --json` stops being parseable —
  // which is how you would script a tarball size check or a supply-chain audit on the package
  // whose entire purpose is being audited by other people. `core` learned this and wrote the
  // reason down; this package was added afterwards and did not inherit it.
  process.stderr.write(`wrote ${String(Object.keys(built).length)} OVP schemas to dist/schema/\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
