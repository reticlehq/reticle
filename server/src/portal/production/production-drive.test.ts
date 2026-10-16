import { describe, expect, it } from 'vitest';
import {
  ActionType,
  EventType,
  HelloScope,
  PRODUCTION_REFUSAL_PREFIX,
  ProductionRule,
  ReticleCommand,
  type ReticleEvent,
} from '@reticlehq/core';
import {
  ProductionDrive,
  assertNativeAllowed,
  rulesAsked,
  type ProductionGrant,
} from './production-drive.js';

const ORIGIN = 'https://app.example.com';
const NOW = 1_000;

function drive(
  grant: Partial<ProductionGrant> & { expiresAt?: number } = {},
  now = NOW,
): ProductionDrive {
  return new ProductionDrive(
    { scope: HelloScope.ACT, origin: ORIGIN, expiresAt: NOW + 60_000, ...grant },
    () => now,
  );
}

/** An inspect that answers every ref with this control. */
const showing = (control: Record<string, unknown>) => (): Promise<unknown> =>
  Promise.resolve(control);

const click = { ref: 'e1', action: ActionType.CLICK };

function refusalOf(rule: ProductionRule): string {
  return `${PRODUCTION_REFUSAL_PREFIX}${rule}`;
}

/** Each refused category: a control that names it, and an intent that asks for it. */
const CATEGORIES: readonly {
  rule: ProductionRule;
  control: Record<string, unknown>;
  intent: string;
  request: [string, string];
}[] = [
  {
    rule: ProductionRule.PAYMENT,
    control: { role: 'button', name: 'Upgrade to Pro' },
    intent: 'upgrade the workspace and pay with the test card',
    request: ['POST', '/v1/billing/checkout'],
  },
  {
    rule: ProductionRule.DELETE_WORKSPACE,
    control: { role: 'button', name: 'Delete project' },
    intent: 'delete the project named Old',
    request: ['DELETE', '/v1/projects/proj_live_1'],
  },
  {
    rule: ProductionRule.REVOKE_KEY,
    control: { role: 'button', name: 'Revoke key' },
    intent: 'rotate the signing key',
    request: ['POST', '/v1/keys/key_123/rotate'],
  },
  {
    rule: ProductionRule.SEND_INVITE,
    control: { role: 'button', name: 'Send invite' },
    intent: 'invite a teammate by email',
    request: ['POST', '/v1/invites'],
  },
  {
    rule: ProductionRule.CANCEL_SUBSCRIPTION,
    control: { role: 'button', name: 'Cancel subscription' },
    intent: 'cancel the subscription',
    request: ['DELETE', '/v1/subscriptions/sub_1'],
  },
  {
    rule: ProductionRule.CHANGE_ROLE,
    control: { role: 'button', name: 'Make admin' },
    intent: "change the member's role to admin",
    request: ['PATCH', '/v1/members/mem_1'],
  },
];

describe('the production action policy', () => {
  for (const c of CATEGORIES) {
    describe(c.rule, () => {
      it('refuses the control unless the intent names it', async () => {
        const refused = await drive().refuseCommand(ReticleCommand.ACT, click, showing(c.control));
        expect(refused).toContain(refusalOf(c.rule));
        const allowed = await drive({ intent: c.intent }).refuseCommand(
          ReticleCommand.ACT,
          click,
          showing(c.control),
        );
        expect(allowed).toBeUndefined();
      });

      it('refuses the request unless the intent names it', () => {
        expect(drive().refuseRequest(...c.request)).toContain(refusalOf(c.rule));
        expect(drive({ intent: c.intent }).refuseRequest(...c.request)).toBeUndefined();
      });
    });
  }

  it('reads an intent that says NOT to as asking for nothing', () => {
    expect(rulesAsked('she does not invite anybody')).toEqual([]);
    expect(rulesAsked('invite a teammate')).toEqual([ProductionRule.SEND_INVITE]);
  });

  it('allows navigation, reading, filters and panels', async () => {
    const d = drive();
    const plain = showing({ role: 'button', name: 'Open filters' });
    expect(await d.refuseCommand(ReticleCommand.SNAPSHOT, {}, plain)).toBeUndefined();
    expect(await d.refuseCommand(ReticleCommand.NAVIGATE, { url: '/runs' }, plain)).toBeUndefined();
    expect(await d.refuseCommand(ReticleCommand.ACT, click, plain)).toBeUndefined();
    const tab = showing({ role: 'tab', name: 'Team' });
    expect(await d.refuseCommand(ReticleCommand.ACT, click, tab)).toBeUndefined();
    expect(d.refuseRequest('GET', '/v1/projects/proj_1')).toBeUndefined();
    expect(d.refuseRequest('POST', '/v1/runs/query')).toBeUndefined();
  });

  it('refuses leaving the activated origin, and allows staying on it', async () => {
    const d = drive();
    const plain = showing({});
    expect(
      await d.refuseCommand(ReticleCommand.NAVIGATE, { url: 'https://pay.example.org/' }, plain),
    ).toContain(refusalOf(ProductionRule.OFF_ORIGIN));
    expect(
      await d.refuseCommand(ReticleCommand.NAVIGATE, { url: `${ORIGIN}/settings` }, plain),
    ).toBeUndefined();
  });

  it('refuses every act under scope observe, and still reads', async () => {
    const d = drive({ scope: HelloScope.OBSERVE });
    const plain = showing({ role: 'button', name: 'Open filters' });
    expect(await d.refuseCommand(ReticleCommand.ACT, click, plain)).toContain(
      refusalOf(ProductionRule.OBSERVE_ONLY),
    );
    expect(await d.refuseCommand(ReticleCommand.ACT_SEQUENCE, { steps: [click] }, plain)).toContain(
      refusalOf(ProductionRule.OBSERVE_ONLY),
    );
    expect(await d.refuseCommand(ReticleCommand.QUERY, {}, plain)).toBeUndefined();
  });

  it('refuses every act once the nonce expires', async () => {
    const d = drive({ expiresAt: NOW });
    const plain = showing({ role: 'button', name: 'Open filters' });
    expect(await d.refuseCommand(ReticleCommand.ACT, click, plain)).toContain(
      refusalOf(ProductionRule.EXPIRED),
    );
  });

  it('allows deleting what the drive itself created, and only that', async () => {
    const d = drive();
    const created: ReticleEvent = {
      type: EventType.NET_REQUEST,
      t: 1,
      sessionId: 'tab-1',
      data: {
        method: 'POST',
        url: `${ORIGIN}/v1/projects`,
        status: 201,
        responseBody: JSON.stringify({ project: { id: 'proj_mine_1' } }),
      },
    };
    d.noteEvent(created);
    expect(d.refuseRequest('DELETE', '/v1/projects/proj_mine_1')).toBeUndefined();
    const mine = showing({ role: 'button', name: 'Delete project', testid: 'delete-proj_mine_1' });
    expect(await d.refuseCommand(ReticleCommand.ACT, click, mine)).toBeUndefined();
    expect(d.refuseRequest('DELETE', '/v1/projects/proj_live_1')).toContain(
      refusalOf(ProductionRule.DELETE_WORKSPACE),
    );
  });

  it('judges each step of a sequence, by its target when it has no ref', async () => {
    const steps = [
      { target: { role: 'button', name: 'Open settings' }, action: ActionType.CLICK },
      { target: { role: 'button', name: 'Revoke key' }, action: ActionType.CLICK },
    ];
    expect(
      await drive().refuseCommand(ReticleCommand.ACT_SEQUENCE, { steps }, showing({})),
    ).toContain(refusalOf(ProductionRule.REVOKE_KEY));
  });

  it('reads a role picker as changing a role', async () => {
    const select = { ref: 'e1', action: ActionType.SELECT, value: 'Admin' };
    expect(
      await drive().refuseCommand(
        ReticleCommand.ACT,
        select,
        showing({ role: 'combobox', name: 'Role' }),
      ),
    ).toContain(refusalOf(ProductionRule.CHANGE_ROLE));
  });

  it('recognises a form by the request its target would send', async () => {
    const submit = showing({ role: 'button', name: 'Continue', formAction: '/v1/invites' });
    expect(await drive().refuseCommand(ReticleCommand.ACT, click, submit)).toContain(
      refusalOf(ProductionRule.SEND_INVITE),
    );
  });

  it('tells the next act about a request it refused, once', async () => {
    const d = drive();
    d.refuseRequest('POST', '/v1/invites');
    const plain = showing({ role: 'button', name: 'Open filters' });
    expect(await d.refuseCommand(ReticleCommand.ACT, click, plain)).toContain(
      refusalOf(ProductionRule.SEND_INVITE),
    );
    expect(await d.refuseCommand(ReticleCommand.ACT, click, plain)).toBeUndefined();
  });

  it('uses the policy list the session supplied in place of the default', () => {
    const d = drive({
      policy: [{ rule: ProductionRule.SEND_INVITE, methods: ['POST'], path: '/team/add$' }],
    });
    expect(d.refuseRequest('POST', '/team/add')).toContain(refusalOf(ProductionRule.SEND_INVITE));
    expect(d.refuseRequest('POST', '/v1/invites')).toBeUndefined();
  });
});

describe('a native gesture on a production drive', () => {
  it('is refused before it is performed, and a plain one passes', async () => {
    const d = drive();
    await expect(
      assertNativeAllowed(d, ActionType.CLICK, { role: 'button', name: 'Send invite' }),
    ).rejects.toThrow(refusalOf(ProductionRule.SEND_INVITE));
    await expect(
      assertNativeAllowed(d, ActionType.CLICK, { role: 'button', name: 'Open filters' }),
    ).resolves.toBeUndefined();
    await expect(
      assertNativeAllowed(undefined, ActionType.CLICK, { name: 'Send invite' }),
    ).resolves.toBeUndefined();
  });
});
