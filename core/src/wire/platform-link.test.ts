import { describe, expect, it } from 'vitest';
import {
  DriveMode,
  DriveTarget,
  SpecIgnoredReason,
  TOOL_SESSION_LIMITS,
  parseDriveSpec,
  parseToolSessionReply,
} from './platform-link.js';
import { HudVisibility } from './constants/hud-use.js';

describe('a drive spec, as an older or newer daemon reads it', () => {
  it('applies every field it knows', () => {
    expect(
      parseDriveSpec({
        target: 'headed',
        mode: 'platform',
        url: 'http://localhost:3000/cart',
        hud: 'hidden',
        persona: 'a returning shopper',
        maxSteps: 40,
        record: false,
      }),
    ).toEqual({
      spec: {
        target: DriveTarget.HEADED,
        mode: DriveMode.PLATFORM,
        url: 'http://localhost:3000/cart',
        hud: HudVisibility.HIDDEN,
        persona: 'a returning shopper',
        maxSteps: 40,
        record: false,
      },
      ignored: [],
    });
  });

  it('keeps the rest when one field is bad, and names a field from a newer platform', () => {
    expect(parseDriveSpec({ target: 'cloud', hud: 'shown', repeat: 5 })).toEqual({
      spec: { hud: HudVisibility.SHOWN },
      ignored: [
        { field: 'target', reason: SpecIgnoredReason.INVALID },
        { field: 'repeat', reason: SpecIgnoredReason.UNKNOWN },
      ],
    });
  });

  it('refuses an address that is not http(s)', () => {
    expect(parseDriveSpec({ url: 'file:///etc/passwd' }).ignored).toEqual([
      { field: 'url', reason: SpecIgnoredReason.INVALID },
    ]);
  });

  it('reads nothing from something that is not a spec, without throwing', () => {
    for (const raw of [undefined, null, 'headed', [1], 7])
      expect(parseDriveSpec(raw)).toEqual({ spec: {}, ignored: [] });
  });
});

describe("the platform's answer to a tool session", () => {
  it('reads the calls it can, and drops one it cannot', () => {
    expect(
      parseToolSessionReply({
        calls: [
          { seq: 1, tool: 'reticle_look', args: { action: 'page' } },
          { seq: 'two', tool: 'reticle_act' },
          { seq: 3, tool: 'reticle_assert' },
        ],
      }),
    ).toEqual({
      calls: [
        { seq: 1, tool: 'reticle_look', args: { action: 'page' } },
        { seq: 3, tool: 'reticle_assert', args: {} },
      ],
      done: false,
    });
  });

  it('stops when told, when given nothing to do, or when the answer does not read', () => {
    expect(parseToolSessionReply({ calls: [], done: true }).done).toBe(true);
    expect(parseToolSessionReply({ calls: [] }).done).toBe(true);
    expect(parseToolSessionReply('garbage').done).toBe(true);
  });

  it('takes no more than one batch from one answer', () => {
    const calls = Array.from({ length: 100 }, (_, seq) => ({
      seq,
      tool: 'reticle_look',
      args: {},
    }));
    expect(parseToolSessionReply({ calls }).calls).toHaveLength(TOOL_SESSION_LIMITS.MAX_BATCH);
  });
});
