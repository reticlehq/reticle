import { describe, expect, it } from 'vitest';
import { PlatformLinkVia, TelemetryEventKind } from '@reticlehq/core/telemetry';
import type { TelemetryExtra } from './telemetry.js';
import { reportPlatformLinked } from './platform-linked.js';

function recorder(): {
  sent: { kind: string; extra: TelemetryExtra | undefined }[];
  emit: (kind: TelemetryEventKind, extra?: TelemetryExtra) => Promise<boolean>;
} {
  const sent: { kind: string; extra: TelemetryExtra | undefined }[] = [];
  return {
    sent,
    emit: (kind, extra) => {
      sent.push({ kind, extra });
      return Promise.resolve(true);
    },
  };
}

describe('platform_linked', () => {
  it('fires for a new binding, with how and the workspace id', () => {
    const t = recorder();
    reportPlatformLinked(
      {
        via: PlatformLinkVia.CONNECT,
        priorProjectId: undefined,
        projectId: 'p',
        workspaceId: 'org_1',
      },
      t,
    );
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.kind).toBe(TelemetryEventKind.PLATFORM_LINKED);
    expect(t.sent[0]?.extra?.link).toEqual({ via: PlatformLinkVia.CONNECT });
    expect(t.sent[0]?.extra?.workspaceId).toBe('org_1');
  });

  it('fires when a repo is re-pointed at another project', () => {
    const t = recorder();
    reportPlatformLinked(
      {
        via: PlatformLinkVia.LINK,
        priorProjectId: 'old',
        projectId: 'new',
        workspaceId: undefined,
      },
      t,
    );
    expect(t.sent).toHaveLength(1);
  });

  it('stays quiet when link is re-run against the same project', () => {
    const t = recorder();
    reportPlatformLinked(
      { via: PlatformLinkVia.HUD, priorProjectId: 'p', projectId: 'p', workspaceId: 'org_1' },
      t,
    );
    expect(t.sent).toEqual([]);
  });
});
