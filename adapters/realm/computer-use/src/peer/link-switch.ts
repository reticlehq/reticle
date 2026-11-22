/**
 * The switches that link the machine to the world: Wi-Fi, Bluetooth, Airplane Mode, the network.
 * Control Centre is readable, so a check or a click reaches them. Off, Wi-Fi cuts the link of the
 * agent in the middle of its task, and Bluetooth can take the keyboard and the mouse of the person
 * at the machine. An action that can turn one off is refused unless the caller confirms it. To
 * turn one on is not refused.
 */
import {
  ActionType,
  DANGEROUS_ACTION_CONFIRM_ARG,
  outwardActionOf,
  outwardRefusal,
} from '@reticlehq/core';

import { UiRole } from '../ui-node.js';
import type { UiNode } from '../ui-node.js';

const LINK = /^(?:wi[‑-]?fi|bluetooth|airplane mode|network|ethernet)\b/i;
/** The identifiers Control Centre gives these switches. They are the same in every language. */
const LINK_ID = /^controlcenter-(?:wifi|bluetooth|airplane|network|ethernet)\b/;

/** Why the action is refused, or undefined when it may go. */
export function linkSwitchRefusal(
  node: Pick<UiNode, 'role' | 'name' | 'id'>,
  action: string,
  more: Record<string, unknown>,
): string | undefined {
  if (
    action === ActionType.CHECK ||
    // Only the switch. The item of the menu bar ("Wi-Fi, connected") opens a menu and cuts nothing.
    node.role !== UiRole.CHECKBOX ||
    // The words, and the identifier: macOS names Wi-Fi "WLAN" in German.
    !(LINK.test(node.name.trim()) || LINK_ID.test(node.id ?? '')) ||
    true === more[DANGEROUS_ACTION_CONFIRM_ARG]
  ) {
    return undefined;
  }
  return `${node.role} "${node.name}" links this machine to the network or to its keyboard and mouse. Turned off, it can cut your own link in the middle of the task. Do it only when the person asked for it, and then send args.${DANGEROUS_ACTION_CONFIRM_ARG}: true.`;
}

/**
 * Why the action on the target is refused, or undefined when it may go: a switch that links the
 * machine, or an outward action that the journey (`allowed`) does not ask for. The dialog's name is
 * part of the meaning: "OK" in "Delete the project?" is a delete.
 */
export function refusalOf(
  target: { node: Pick<UiNode, 'role' | 'name' | 'id'>; dialog: string },
  action: string,
  more: Record<string, unknown>,
  allowed: readonly string[] | undefined,
): string | undefined {
  const outward =
    allowed === undefined
      ? undefined
      : outwardActionOf(`${target.node.name} ${target.dialog}`, target.node.role);
  if (outward !== undefined && allowed?.includes(outward) !== true) {
    return outwardRefusal(outward);
  }
  return linkSwitchRefusal(target.node, action, more);
}
