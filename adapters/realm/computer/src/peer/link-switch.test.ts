import { ActionType } from '@reticlehq/core';
import { describe, expect, it } from 'vitest';

import { UiRole } from '../ui-node.js';
import { linkSwitchRefusal } from './link-switch.js';

describe('a switch that links the machine', () => {
  // macOS names Wi-Fi "WLAN" in German, and the name did not match: an agent could turn it off on
  // such a Mac and cut its own link. Control Centre gives the switch an identifier in every
  // language.
  it('is found by the identifier of Control Centre, in any language', () => {
    for (const id of ['controlcenter-wifi', 'controlcenter-bluetooth']) {
      const node = { role: UiRole.CHECKBOX, name: 'WLAN: Zuhause', id };
      expect(linkSwitchRefusal(node, ActionType.UNCHECK, {})).toMatch(/confirmDangerous/);
    }
  });

  it('is not a switch that cuts nothing, whatever its words', () => {
    const node = { role: UiRole.CHECKBOX, name: 'AirDrop', id: 'controlcenter-airdrop' };
    expect(linkSwitchRefusal(node, ActionType.UNCHECK, {})).toBeUndefined();
  });
});
