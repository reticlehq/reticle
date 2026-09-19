/**
 * Malformed intent input is refused BEFORE anything on disk is touched.
 *
 * Reported repeatedly from the field (#994). `reticle_run` checks only that a tool's argument NAMES
 * are known, never that their shapes are — so `reticle_intent { action: "declare", intents: [{ id,
 * statement, surface: "/authorize" }] }`, with `surface` as a bare string where the ledger requires
 * `{ route: "/authorize" }`, reached the store with nothing having looked at it. The store wrote it.
 *
 * What made a bad argument into DATA LOSS is the read on the other side: `parseIntentFile` fails
 * soft to empty, deliberately, because a hand-merged `.reticle/intent.json` with a conflict marker
 * in it must not take a verdict down. So the malformed row did not fail loudly — every later read
 * answered "no intents", and the next declaration was a read-modify-write over that empty answer,
 * which rewrote the file with the one new row. A reporter found a committed ledger replaced by a
 * single record, through `git diff`.
 *
 * The same shape reaches the sharded store: a record with a `status` the enum does not know, or with
 * no statement at all, makes its whole shard unparseable, and `#readShard` then falls back to an
 * empty shard that the next write persists over the top of every record that subject held.
 *
 * So these specs pin the input half only: a write is refused, and the ledger that was already there
 * is still readable afterwards. The read half — that a ledger which will not parse must not be
 * reported as an empty one — is a separate defect and a separate change.
 */
import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { createMemoryFs } from '@/memory/project/memory-fs.js';
import { buildErrorPayload } from '@/surface/tools/error-recovery.js';
import { INTENT_TOOLS } from './intent-tools.js';
import { IntentStore } from './intent-store.js';
import { IntentShardStore } from './intent-shard-store.js';
import { IntentStatus } from './intent-shard.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';

const ROOT = '/repo/.reticle';
const NOW = 1_000;

/** The one live surface these defects arrived through. Looked up by name, never by position. */
const intentTool = INTENT_TOOLS.find((tool) => ReticleTool.INTENT === tool.name);

interface Harness {
  /** Call `reticle_intent` exactly as a dispatcher would — an args bag, unchecked. */
  call: (args: Record<string, unknown>) => Promise<unknown>;
  /** Every byte that reached disk, so "nothing was written" is checkable rather than asserted. */
  written: Map<string, string>;
}

function harness(): Harness {
  const { fs, written } = createMemoryFs();
  const deps = {
    fs,
    reticleRoot: ROOT,
    now: () => NOW,
    sessions: {
      resolve: () => ({ id: 's1', url: 'http://app.test/', projectId: undefined }),
    },
  } as unknown as ToolDeps;
  return {
    call: (args) => {
      if (intentTool === undefined) throw new Error(`${ReticleTool.INTENT} is not registered`);
      return intentTool.handler(deps, args);
    },
    written,
  };
}

/** The ids `list` can still see — the question every reporter in #994 was actually asking. */
async function listedIds(call: Harness['call']): Promise<string[]> {
  const listed = (await call({ action: 'list' })) as { intents?: unknown[] };
  return (listed.intents ?? []).map((intent) => String((intent as { id?: unknown }).id));
}

describe('a malformed declaration never reaches the flat ledger', () => {
  it('refuses a surface that is a bare string where the schema requires { route }', async () => {
    const { call, written } = harness();
    await call({
      action: 'declare',
      intents: [{ id: 'sign-in', statement: 'signing in lands on the dashboard' }],
    });
    const before = new Map(written);

    await expect(
      call({
        action: 'declare',
        intents: [
          { id: 'authorize', statement: 'the authorize page renders', surface: '/authorize' },
        ],
      }),
    ).rejects.toThrow(/surface/);

    expect(written, 'the refused call still wrote').toEqual(before);
  });

  /**
   * The reporter's own story, stated as an invariant rather than as a message: whatever the tool
   * answers, the intents that were already committed are still there afterwards.
   */
  it('leaves every intent already in the ledger readable afterwards', async () => {
    const { call } = harness();
    await call({
      action: 'declare',
      intents: [
        { id: 'sign-in', statement: 'signing in lands on the dashboard' },
        { id: 'sign-out', statement: 'signing out returns to the marketing page' },
      ],
    });

    await call({
      action: 'declare',
      intents: [
        { id: 'authorize', statement: 'the authorize page renders', surface: '/authorize' },
      ],
    }).catch(() => undefined);

    expect(await listedIds(call)).toEqual(['sign-in', 'sign-out']);
  });

  /** A batch is one write, so it is one decision: all of it lands or none of it does. */
  it('refuses the whole batch when a single entry is malformed', async () => {
    const { call, written } = harness();
    const before = new Map(written);

    await expect(
      call({
        action: 'declare',
        intents: [
          { id: 'good', statement: 'the cart total includes tax' },
          { id: 'bad', statement: 'the authorize page renders', surface: '/authorize' },
        ],
      }),
    ).rejects.toThrow(/surface/);

    expect(written, 'half a batch was written').toEqual(before);
    expect(await listedIds(call)).toEqual([]);
  });

  it('refuses an entry whose statement is empty rather than storing a row nothing parses', async () => {
    const { call, written } = harness();
    const before = new Map(written);

    await expect(
      call({ action: 'declare', intents: [{ id: 'blank', statement: '' }] }),
    ).rejects.toThrow(/statement/);

    expect(written).toEqual(before);
  });

  it('refuses an id that is not a string, which would key the ledger on a number', async () => {
    const { call, written } = harness();
    const before = new Map(written);

    await expect(
      call({ action: 'declare', intents: [{ id: 42, statement: 'the cart total includes tax' }] }),
    ).rejects.toThrow(/id/);

    expect(written).toEqual(before);
  });

  it('refuses `intents` that is not an array at all', async () => {
    const { call, written } = harness();
    const before = new Map(written);

    await expect(
      call({ action: 'declare', intents: { id: 'one', statement: 'not in an array' } }),
    ).rejects.toThrow(/intents/);

    expect(written).toEqual(before);
  });
});

describe('a malformed record never reaches a shard', () => {
  it('refuses a status the ledger does not know, leaving the shard byte-identical', async () => {
    const { call, written } = harness();
    await call({
      action: 'record',
      id: 'checkout-tax',
      statement: 'tax is recalculated when the delivery country changes',
      subject: 'checkout',
    });
    const before = new Map(written);

    await expect(
      call({
        action: 'record',
        id: 'checkout-ship',
        statement: 'shipping is free above the threshold',
        subject: 'checkout',
        status: 'maybe',
      }),
    ).rejects.toThrow(/status/);

    expect(written, 'the shard was rewritten by a refused call').toEqual(before);
  });

  /**
   * `record` merges onto what is stored but overwrites `statement` unconditionally, so an update
   * that omits it used to blank the prose — which is the one field `IntentRecordSchema` requires,
   * and therefore takes the whole shard out of readability with it.
   */
  it('refuses an update with no statement rather than blanking the one already stored', async () => {
    const { call } = harness();
    await call({
      action: 'record',
      id: 'checkout-tax',
      statement: 'tax is recalculated when the delivery country changes',
      subject: 'checkout',
    });

    await expect(
      call({ action: 'record', id: 'checkout-tax', why: 'a customer was charged the wrong tax' }),
    ).rejects.toThrow(/statement/);

    const got = (await call({ action: 'get', id: 'checkout-tax' })) as {
      record?: { statement?: string } | null;
    };
    expect(got.record?.statement).toBe('tax is recalculated when the delivery country changes');
  });

  it('refuses a record with no id, which would otherwise be filed under the empty string', async () => {
    const { call, written } = harness();
    const before = new Map(written);

    await expect(
      call({ action: 'record', statement: 'shipping is free above the threshold' }),
    ).rejects.toThrow(/id/);

    expect(written).toEqual(before);
  });
});

/**
 * A refusal is classified by its WORDING, and the default classification is "this may be a defect in
 * Reticle — file a bug report". Being told to report its own typo costs an agent a turn and costs
 * the feedback channel a report about nothing, and `tool-fuzz-test.mjs` fails the battery on it.
 */
describe('a refused write is the caller’s argument to fix, not a Reticle defect to report', () => {
  it('is answered with the schema recovery rather than an ask to file a bug', async () => {
    const { call } = harness();
    const message = await call({
      action: 'declare',
      intents: [
        { id: 'authorize', statement: 'the authorize page renders', surface: '/authorize' },
      ],
    }).then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    const payload = buildErrorPayload(message);
    expect(payload.feedback, 'the agent was asked to report its own bad argument').toBeUndefined();
    expect(payload.recovery).toBeDefined();
  });

  it('says that nothing was written, because that decides what the agent does next', async () => {
    const { call } = harness();
    await expect(
      call({ action: 'declare', intents: [{ id: 'blank', statement: '' }] }),
    ).rejects.toThrow(/NOTHING was written/);
  });
});

describe('the stores refuse on their own account, not because a tool checked first', () => {
  it('IntentStore.declare writes nothing for a batch it cannot parse', async () => {
    const { fs, written } = createMemoryFs();
    const store = new IntentStore(fs, ROOT, { now: () => NOW });
    await store.declare([{ id: 'kept', statement: 'the cart total includes tax' }]);
    const before = new Map(written);

    await expect(store.declare([{ id: 'lost', statement: 42 }])).rejects.toThrow(/statement/);

    expect(written).toEqual(before);
    expect((await store.read()).map((intent) => intent.id)).toEqual(['kept']);
  });

  it('IntentShardStore.record writes nothing for input it cannot parse', async () => {
    const { fs, written } = createMemoryFs();
    const store = new IntentShardStore(fs, ROOT, { now: () => NOW });
    await store.record({ id: 'kept', statement: 'the cart total includes tax', subject: 'cart' });
    const before = new Map(written);

    await expect(store.record({ id: 'lost', statement: '' })).rejects.toThrow(/statement/);

    expect(written).toEqual(before);
    expect((await store.subject('cart')).map((record) => record.id)).toEqual(['kept']);
  });
});

/**
 * The other half of the same change, and the more important one: nothing valid got stricter. Every
 * spec here passes both before and after the fix, and is the reason the fix is a refusal of what the
 * schema already rejected rather than a new opinion about what an intent may be.
 */
describe('valid input is untouched', () => {
  it('declares a batch carrying the nested surface the schema asks for', async () => {
    const { call } = harness();
    await call({
      action: 'declare',
      intents: [
        {
          id: 'authorize',
          statement: 'the authorize page renders',
          surface: { route: '/authorize' },
        },
        { id: 'sign-in', statement: 'signing in lands on the dashboard' },
      ],
    });

    const listed = (await call({ action: 'list' })) as {
      intents?: { id?: string; surface?: unknown }[];
    };
    expect((listed.intents ?? []).map((intent) => intent.id)).toEqual(['authorize', 'sign-in']);
    expect((listed.intents ?? [])[0]?.surface).toEqual({ route: '/authorize' });
  });

  it('keeps a surface carrying a flow and files, which the ledger has always allowed', async () => {
    const { call } = harness();
    await call({
      action: 'declare',
      intents: [
        {
          id: 'checkout-pay',
          statement: 'paying shows the receipt',
          surface: { route: '/checkout', flow: 'checkout-pay', files: ['src/checkout/pay.tsx'] },
        },
      ],
    });

    const got = (await call({ action: 'get', id: 'checkout-pay' })) as {
      record?: { surface?: unknown } | null;
    };
    expect(got.record?.surface).toEqual({
      route: '/checkout',
      flow: 'checkout-pay',
      files: ['src/checkout/pay.tsx'],
    });
  });

  it('records the metadata the sharded store exists for', async () => {
    const { call } = harness();
    await call({
      action: 'record',
      id: 'checkout-tax',
      statement: 'tax is recalculated when the delivery country changes',
      subject: 'checkout',
      why: 'a customer was charged the wrong tax and we refunded it by hand',
      source: 'support ticket 4821',
      status: IntentStatus.AGREED,
    });

    const got = (await call({ action: 'get', id: 'checkout-tax' })) as {
      record?: { why?: string; source?: string; status?: string } | null;
    };
    expect(got.record?.why).toBe('a customer was charged the wrong tax and we refunded it by hand');
    expect(got.record?.source).toBe('support ticket 4821');
    expect(got.record?.status).toBe(IntentStatus.AGREED);
  });

  it('still answers `declare` with nothing to declare by writing nothing', async () => {
    const { call, written } = harness();
    const answer = (await call({ action: 'declare', intents: [] })) as { intents?: unknown[] };
    expect(answer.intents).toEqual([]);
    expect(written.size).toBe(0);
  });

  it('still reports a bind against an unknown id as unbound, without writing', async () => {
    const { call, written } = harness();
    const answer = (await call({ action: 'bind', id: 'nobody', binding: { kind: 'text' } })) as {
      bound?: boolean;
    };
    expect(answer.bound).toBe(false);
    expect(written.size).toBe(0);
  });
});
