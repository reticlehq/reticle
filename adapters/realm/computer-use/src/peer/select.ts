/**
 * `select`: one choice of a pop-up or a list, taken the way a person takes it.
 */
import { ActionType } from '@reticlehq/core';

import { ActKind, Delivery } from '../driver.js';
import type { ActOutcome, UiDriver } from '../driver.js';
import type { Change } from '../effect.js';
import type { RefTable } from '../lines.js';
import { UiRole, place, quoted } from '../ui-node.js';
import { CHOICES_NAMED, ESCAPE, SettleReason, heldBy } from './form.js';
import type { ActResult } from './form.js';
import { see } from './seen.js';
import type { Seen } from './seen.js';

/** Room for an effect that comes up to a second late, and then the quiet time after it. */
const SETTLE_MS = 1500;

interface How {
  delivery: Delivery;
  budgetMs: number;
}

/** What `select` needs of the peer: its reads, its refs, and its one way to act. */
export interface SelectContext {
  driver: UiDriver;
  refs: RefTable;
  drive: (
    target: Seen,
    ref: string,
    kind: ActKind,
    value: string | undefined,
    how: How,
  ) => Promise<{ outcome: ActOutcome; changes: Change[] }>;
  act: (args: Record<string, unknown>, allowed?: readonly string[]) => Promise<ActResult>;
}

/**
 * Chooses one item of a pop-up as a person does: press the pop-up, read its choices, press the
 * one asked for. When that choice is not there, the pop-up is closed again and the answer
 * names the choices that are.
 */
export async function selectChoice(
  ctx: SelectContext,
  ref: string,
  more: Record<string, unknown>,
  allowed?: readonly string[],
): Promise<ActResult> {
  const wanted = more['value'];
  if ('string' !== typeof wanted) {
    throw new Error(`${ActionType.SELECT} needs the name of the choice: args: { value: "…" }.`);
  }
  const read = await ctx.driver.read();
  const key = ctx.refs.keyOf(ref);
  const popup = see(read.root).find((s) => s.key === key);
  if (popup === undefined) {
    throw new Error(`ref '${ref}' no longer resolves to an element`);
  }
  const how = { delivery: Delivery.USER_PATH, budgetMs: SETTLE_MS };
  // A list in a web view has no choice with a name below it, open or closed. A person types
  // the name into the list, and the list goes to that choice. The pop-up is not opened: it is
  // a window of its own there, and a key that is sent to the application does not close it.
  const named = place(read.root).some(
    (p) =>
      p.key.startsWith(`${popup.key}/`) && p.node.role === UiRole.MENUITEM && '' !== p.node.name,
  );
  if (popup.node.role === UiRole.COMBOBOX && !named) {
    return selectByTyping(ctx, popup, ref, wanted, how);
  }
  await ctx.drive(popup, ref, ActKind.PRESS, undefined, how);
  const choices = see((await ctx.driver.read()).root).filter(
    (s) => s.visible && s.node.role === UiRole.MENUITEM && s.key.startsWith(popup.key),
  );
  const choice = choices.find((s) => s.node.name === wanted);
  if (choice === undefined) {
    // The pop-up that this action opened lies over its own control, so the control is "not
    // reachable" now. The key that closes the pop-up goes to the application without that check.
    await ctx.drive(popup, ref, ActKind.KEY, ESCAPE, { ...how, delivery: Delivery.DIRECT });
    throw new Error(
      `${popup.node.role} "${popup.node.name}" has no choice ${quoted(wanted)}. It has: ${choices
        .slice(0, CHOICES_NAMED)
        .map((s) => quoted(s.node.name))
        .join(', ')}.`,
    );
  }
  const pressed = await ctx.act(
    { ref: ctx.refs.refFor(choice.key), action: ActionType.CLICK, args: more },
    allowed,
  );
  return { ...pressed, ref, action: ActionType.SELECT };
}

async function selectByTyping(
  ctx: SelectContext,
  popup: Seen,
  ref: string,
  wanted: string,
  how: How,
): Promise<ActResult> {
  const typed = await ctx.drive(popup, ref, ActKind.TYPE, wanted, how);
  const held = heldBy(typed.outcome, popup.key);
  const was = popup.node.value ?? '';
  if (held !== wanted) {
    if (held !== was) {
      // The keys went to another choice that starts the same way. Put the old one back.
      await ctx.drive(popup, ref, ActKind.TYPE, was, how);
    }
    throw new Error(
      `${popup.node.role} "${popup.node.name}" did not go to the choice ${quoted(wanted)}: it holds ${quoted(was)}. The list does not name its choices, so the realm typed the name.`,
    );
  }
  const settled = typed.outcome.settled;
  return {
    ok: true,
    ref,
    action: ActionType.SELECT,
    dispatched: true,
    settled,
    settleReason: settled ? null : SettleReason.TIMEOUT,
    effect: {
      dispatched: true,
      targetMatched: true,
      valueChanged: typed.changes.some((c) => c.value !== undefined),
      domMutatedWithin: typed.changes.length,
    },
    role: popup.node.role,
    name: popup.node.name,
  };
}
